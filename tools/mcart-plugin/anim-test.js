// Behavioural checks for animated textures.
//
// A static check cannot answer "does the strip advance".  `animationRow` can be
// present, correct, and never called; the row can be computed and then thrown
// away by the sampler.  So this evaluates the EMITTED source and looks at the
// pixels the rasteriser actually produces for a two-frame strip.
//
// The functions are pulled out of the source by name (they are top-level
// declarations), which is what makes this run against the artifact that was
// actually emitted rather than a re-implementation of it.
const fs = require('fs')
const path = require('path')
// Defaults to the client sitting NEXT TO this file, so running the copy in
// tools/mcart-plugin really does test the artifact that was emitted.
const CLIENT = process.env.MCART_CLIENT || path.join(__dirname, 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')

// The sandbox traps browser timer globals, and the trap is a RENDER CRASH, not
// a warning: `setInterval` in the client half took the whole side panel down
// with "setInterval is not available in a dynamic client half".  Comments
// mention these names on purpose, so the check runs on the source with whole
// line comments removed -- otherwise the explanation trips its own test.
const codeOnly = src.replace(/^\s*\/\/.*$/gm, '')

function extract(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('client.js 里没有 ' + name)
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

const parts = ['renderScene', 'animationRow', 'stripOf'].map(extract).join('\n')
const EMPTY_ANIMATIONS = {}
const api = new Function(parts + '\nreturn { renderScene, animationRow, stripOf }')()
const renderScene = api.renderScene

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

// --- a four-wide, two-frame strip: frame 0 red, frame 1 green ----------------
const W = 4, H = 8
const data = new Uint8ClampedArray(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const at = (y * W + x) * 4
    data[at] = y < 4 ? 255 : 0
    data[at + 1] = y < 4 ? 0 : 255
    data[at + 3] = 255
  }
}
const texture = { width: W, height: H, data: data }
const animation = { frames: 2, strip: 2, order: [0, 1], frametime: 1, interpolate: false }

// One quad covering the whole viewport, uv.y = 0 at the top of the screen.
const quads = [{ p: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  uv: [[0, 1], [0, 0], [1, 0], [1, 1]], tex: 't', shade: 1, mode: 'opaque', face: 'north' }]
const camera = { project: (p) => [p[0] * 16, (1 - p[1]) * 16, 1] }

function centre(timeMs, animations) {
  const bytes = renderScene({ width: 16, height: 16, background: [0, 0, 0], camera: camera,
    quads: quads, textures: { t: texture }, animations: animations, timeMs: timeMs })
  const at = (8 * 16 + 8) * 4
  return [bytes[at], bytes[at + 1], bytes[at + 2]]
}

// The midpoint of the quad has v = 0.5.  With animation that is the middle of
// ONE frame; without it, that is row 4 of the strip -- the second frame.
check('时间 0 时取第一帧（红）', JSON.stringify(centre(0, { t: animation })) === '[255,0,0]',
  JSON.stringify(centre(0, { t: animation })))
check('过了一个 tick 走一帧（绿）', JSON.stringify(centre(50, { t: animation })) === '[0,255,0]',
  JSON.stringify(centre(50, { t: animation })))
check('放完回头（红）', JSON.stringify(centre(100, { t: animation })) === '[255,0,0]',
  JSON.stringify(centre(100, { t: animation })))

// frametime is in TICKS (50 ms), the unit the game itself uses.  Reading it as
// milliseconds would play a 5-tick sea lantern twelve times too fast.
const slow = { frames: 2, strip: 2, order: [0, 1], frametime: 5, interpolate: false }
check('frametime 是 tick（50ms）不是毫秒：200ms 仍在第一帧',
  JSON.stringify(centre(200, { t: slow })) === '[255,0,0]', JSON.stringify(centre(200, { t: slow })))
check('frametime 是 tick：250ms 才换帧',
  JSON.stringify(centre(250, { t: slow })) === '[0,255,0]', JSON.stringify(centre(250, { t: slow })))

// A pack may reorder or repeat frames; lava_still declares 38 playback steps
// over a 20-row strip, so the index and the row are not the same number.
const reordered = { frames: 3, strip: 2, order: [1, 1, 0], frametime: 1 }
check('按 order 播放，不是按行号', JSON.stringify(centre(0, { t: reordered })) === '[0,255,0]',
  JSON.stringify(centre(0, { t: reordered })))
check('order 里重复的帧会停两次', JSON.stringify(centre(50, { t: reordered })) === '[0,255,0]',
  JSON.stringify(centre(50, { t: reordered })))

// No description means no animation: the texture is one static sprite and must
// be sampled as a whole, however tall it is.  This is the "no .mcmeta" case.
check('没有动画描述时，整张图照常采样（不裁不切）',
  JSON.stringify(centre(0, {})) === '[0,255,0]' && JSON.stringify(centre(500, {})) === '[0,255,0]',
  JSON.stringify(centre(0, {})) + ' / ' + JSON.stringify(centre(500, {})))

// A texture whose height is not strip*width cannot be divided into frames; the
// description is then a lie and sampling must fall back rather than read
// out of bounds.
const odd = { width: 4, height: 6, data: data.slice(0, 4 * 6 * 4) }
check('尺寸对不上就不按条带采样', api.stripOf({ width: 4, height: 6, animation: animation }) === null)
check('条带能整除时才认', api.stripOf({ width: 4, height: 8, animation: animation }) === 2)

// The redraw trigger is a mechanism, not a pixel, so it is checked as text --
// and this file says so rather than pretending otherwise.
check('动画的帧号进了重绘的 key（否则"没变就不重绘"会把画面冻住）',
  /const animKey = [\s\S]{0,220}animationRow\(animations\[id\]/.test(codeOnly)
  && /key = \[[\s\S]{0,320}animKey\]\.join/.test(codeOnly))
check('计时器只在真的有动画时才开',
  /if \(!animating\) return undefined/.test(codeOnly) && /const animating =/.test(codeOnly))
check('计时器会被关掉（disposer 交给 React 的 cleanup）',
  /if \(typeof dispose === 'function'\) dispose\(\)/.test(codeOnly))
// A 256-tall scratch canvas silently truncates a 16x512 strip at frame 16, and
// reading the missing rows back returns blank pixels instead of failing.  The
// canvas has to grow to fit what was decoded.
check('客户端不碰浏览器计时器全局（沙箱里没有，碰了整个页签会崩）',
  !/\bsetInterval\s*\(/.test(codeOnly) && !/\bclearInterval\s*\(/.test(codeOnly)
  && !/\bsetTimeout\s*\(/.test(codeOnly) && !/\brequestAnimationFrame\s*\(/.test(codeOnly))
check('帧钟来自注入的 timer 服务，不是 Date.now()',
  /inject: \['timer'\]/.test(codeOnly) && /const timer = ctx\.timer/.test(codeOnly)
  && /timer\.interval\(/.test(codeOnly) && !/\bDate\.now\s*\(/.test(codeOnly))
check('timer.interval 的 disposer 交给了 effect 的 cleanup',
  /const dispose = timer\.interval\(/.test(codeOnly) && /if \(typeof dispose === 'function'\) dispose\(\)/.test(codeOnly))
// The diagnostic has to name the two possible causes, because that is the only
// thing that can tell them apart from outside the browser.
check('界面上能看见每张动画贴图的解码尺寸与判定',
  /const animIndex = scene === null \? \{\} : \(scene\.animations \|\| \{\}\)/.test(codeOnly) && /判定 /.test(src)
  && /stripOf\(\{ width: tex\.width, height: tex\.height, animation: animIndex\[id\] \}\)/.test(codeOnly))
check('形状像条带却没有描述时也会报出来（这才是"糊"的另一种成因）',
  /形状像条带但没有动画描述/.test(src) && /tex\.height % tex\.width === 0/.test(codeOnly))
// A cell placed with an orientation is keyed `block@variant` in the host; only
// the bare name was ever sent back, so every edit dropped those extractions.
check('releaseRefs 把带朝向的引用也留在 keep 里',
  /keep\.push\(qualified \+ '@' \+ cell\.variant\)/.test(codeOnly))
check('解码用的画布会撑到贴图那么大（不然 16x512 的水只解出前 16 帧，后面全透明）',
  /const neededHeight = Math\.max\(scratch\.height, node\.naturalHeight\)/.test(src)
  && /scratch\.height = neededHeight/.test(src))

// The diagnostic row is on screen WHILE the user is placing blocks, so where it
// sits and what it reads are both load-bearing.  Reported as: "the tip pops up
// when I select a block, the layout shifts, I cannot click the block any more,
// the tip goes away, I can click again, the tip comes back -- it twitches."
//
// These two are STRUCTURAL checks, the weak kind, and they cannot prove the
// layout is still.  What makes them worth keeping is that both faults are
// invisible to every behavioural check in this file -- nothing in a rasteriser
// knows how tall the panel is -- and each one is a single line away from coming
// back.
const viewportAt = codeOnly.indexOf("key: 'viewport'")
const animsAt = codeOnly.indexOf("key: 'anims'")
check('动画自检行排在画布之后（排在前面就会把画布顶下去，点不中方块）',
  viewportAt >= 0 && animsAt > viewportAt)
const animBuild = codeOnly.slice(codeOnly.indexOf('const animIndex ='), animsAt < 0 ? codeOnly.length : animsAt)
check('自检行只看场景、不看幽灵（看幽灵就会随指针出现/消失，来回抽）',
  animBuild.indexOf('ghost') < 0, animBuild.indexOf('ghost') < 0 ? '干净' : '里面出现了 ghost')

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
