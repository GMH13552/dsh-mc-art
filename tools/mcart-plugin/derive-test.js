// Behavioural checks for "derive the orientation from where I clicked".
//
// The whole point of this change is that the user is no longer asked a question
// the placement already answers.  A static check cannot tell whether the answer
// is right -- it has to be measured -- so this evaluates the emitted client and
// calls the derivation with the faces and hit positions a real click produces.
//
// The functions are pulled out by name (they are top-level declarations), which
// is what makes this run against the artifact that was emitted.
const fs = require('fs')
const path = require('path')
// Defaults next to this file, so the copy in tools/mcart-plugin really does test
// what was emitted rather than the working copy.
const CLIENT = process.env.MCART_CLIENT || path.join(__dirname, 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')

// Comments name these shapes on purpose (they explain what was removed), so the
// structural checks run with whole-line comments stripped.
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
// The tables are `const`, so they come along by name.
function constant(name) {
  const start = src.indexOf('const ' + name + ' = ')
  if (start < 0) throw new Error('client.js 里没有 ' + name)
  let depth = 0
  for (let index = src.indexOf('=', start); index < src.length; index++) {
    const ch = src[index]
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return src.slice(start, index + 1)
    }
  }
  throw new Error('常量没配平：' + name)
}

const body = ['FACE_AXIS', 'FACE_OPPOSITE', 'HORIZONTAL_FACES', 'VALUE_LABEL', 'AXIS_LABEL'].map(constant).join('\n')
  + '\n' + ['labelOfValue', 'labelOfAxis', 'canonicalVariant', 'deriveVariant', 'variantFor', 'faceHitY', 'variantSummary']
    .map(extract).join('\n')
const api = new Function(body + '\nreturn { labelOfValue, labelOfAxis, canonicalVariant, deriveVariant, variantFor, faceHitY, variantSummary, FACE_OPPOSITE, FACE_AXIS }')()

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (detail === undefined ? '' : '  -> ' + detail))
}

// --- axis: exact, and a flip must never change it ---------------------------
const logAxes = [{ name: 'axis', values: ['none', 'x', 'y', 'z'] }]
check('原木点上下 -> axis=y', api.deriveVariant(logAxes, 'up', 0.5, false).axis === 'y')
check('原木点南北 -> axis=z', api.deriveVariant(logAxes, 'north', 0.5, false).axis === 'z')
check('原木点东西 -> axis=x', api.deriveVariant(logAxes, 'east', 0.5, false).axis === 'x')
check('轴没有正面，所以"翻转"不该动它',
  api.deriveVariant(logAxes, 'east', 0.5, true).axis === 'x')

// --- half: exact, straight out of where on the face you clicked -------------
// Vanilla: bottom face -> top slab, top face -> bottom slab, and otherwise
// whichever half of the side was hit.
const slabAxes = [{ name: 'half', values: ['bottom', 'top'] }]
check('台阶/半砖点底面 -> 上半', api.deriveVariant(slabAxes, 'down', 0.9, false).half === 'top')
check('台阶/半砖点顶面 -> 下半', api.deriveVariant(slabAxes, 'up', 0.1, false).half === 'bottom')
check('侧面点在下半 -> 下半', api.deriveVariant(slabAxes, 'north', 0.3, false).half === 'bottom')
check('侧面点在上半 -> 上半', api.deriveVariant(slabAxes, 'north', 0.7, false).half === 'top')
check('侧面正好一半算下半（原版是 <= 0.5）', api.deriveVariant(slabAxes, 'north', 0.5, false).half === 'bottom')

// --- facing: the one rule the data cannot settle ----------------------------
const facingAxes = [{ name: 'facing', values: ['down', 'east', 'north', 'south', 'up', 'west'] }]
check('默认那派：点东面 -> 朝东（熔炉/箱子那一家）',
  api.deriveVariant(facingAxes, 'east', 0.5, false).facing === 'east')
check('翻转那派：点东面 -> 朝西，正好差 180°（楼梯/活板门那一家）',
  api.deriveVariant(facingAxes, 'east', 0.5, true).facing === 'west')
check('四个水平方向都真的是反的',
  ['north', 'south', 'east', 'west'].every((face) =>
    api.deriveVariant(facingAxes, face, 0.5, true).facing === api.FACE_OPPOSITE[face]))
check('竖直的点面翻不动（朝上没有"反面"）',
  api.deriveVariant(facingAxes, 'up', 0.5, true).facing === 'up')
check('竖直方向不能给出水平值', api.deriveVariant(facingAxes, 'down', 0.5, false).facing === 'down')

// --- composition: three sources, and only real variants come out ------------
const cmdAxes = [
  { name: 'conditional', values: ['false', 'true'] },
  { name: 'facing', values: ['down', 'east', 'north', 'south', 'up', 'west'] },
]
const cmdKeys = []
for (const conditional of ['false', 'true']) {
  for (const facing of ['down', 'east', 'north', 'south', 'up', 'west']) {
    cmdKeys.push('conditional=' + conditional + ',facing=' + facing)
  }
}
const cmdDefaults = { conditional: 'false', facing: 'north' }

check('命令方块：conditional 没有推导规则，取默认值，facing 由点击推导',
  api.variantFor(cmdAxes, cmdKeys, cmdDefaults, 'east', 0.5, false, {}) === 'conditional=false,facing=east',
  api.variantFor(cmdAxes, cmdKeys, cmdDefaults, 'east', 0.5, false, {}))
check('命令方块：手选有条件，替换掉默认值（这才是你问的那个标签）',
  api.variantFor(cmdAxes, cmdKeys, cmdDefaults, 'east', 0.5, false, { conditional: 'true' })
    === 'conditional=true,facing=east')
check('命令方块：一共 12 个键，每个都拼得出来',
  ['down', 'east', 'north', 'south', 'up', 'west'].every((face) =>
    cmdKeys.indexOf(api.variantFor(cmdAxes, cmdKeys, cmdDefaults, face, 0.5, false, {})) >= 0))

// 40 variants, 3 questions.  The point of the whole change.
const stairAxes = [
  { name: 'facing', values: ['east', 'north', 'south', 'west'] },
  { name: 'half', values: ['bottom', 'top'] },
  { name: 'shape', values: ['inner_left', 'inner_right', 'outer_left', 'outer_right', 'straight'] },
]
const stairKeys = []
for (const facing of ['east', 'north', 'south', 'west']) {
  for (const half of ['bottom', 'top']) {
    for (const shape of ['inner_left', 'inner_right', 'outer_left', 'outer_right', 'straight']) {
      stairKeys.push('facing=' + facing + ',half=' + half + ',shape=' + shape)
    }
  }
}
const stairDefaults = { facing: 'east', half: 'bottom', shape: 'straight' }
const stair = api.variantFor(stairAxes, stairKeys, stairDefaults, 'west', 0.8, false, {})
check('楼梯：40 个变体由"点西面 + 点上半个"推出来，一个按钮都不用点',
  stair === 'facing=west,half=top,shape=straight', stair)
check('楼梯：形状仍是默认 straight（邻居还没算）',
  stair.indexOf('shape=straight') > 0)

// --- refusing honestly -----------------------------------------------------
check('拼不出真实存在的变体时给 null，而不是编一个键',
  api.variantFor(cmdAxes, ['conditional=false,facing=north'], cmdDefaults, 'east', 0.5, false, {}) === null)
check('没有属性可问时给 null（单变体方块不该出现这一排）',
  api.variantFor([], [], {}, 'east', 0.5, false, {}) === null)
check('缺一个属性的答案就放弃，不发半个键',
  api.variantFor(cmdAxes, cmdKeys, {}, 'east', 0.5, false, {}) === null)

// --- canonical spelling ----------------------------------------------------
check('键按属性名排序拼出来，跟盘的写法无关',
  api.canonicalVariant({ facing: 'east', conditional: 'true' }) === 'conditional=true,facing=east')
check('反序的两个键是同一个键',
  api.canonicalVariant({ conditional: 'false', facing: 'down' })
  === api.canonicalVariant({ facing: 'down', conditional: 'false' }))
check('没有 = 的键（1.13 的 "" / Forge 的 normal）保持原样',
  api.canonicalVariant({}) === '' && api.canonicalVariant({ normal: '' }) === 'normal=')

// --- hit position on the face ----------------------------------------------
// A quad spanning y 0..1, projected so one world unit is 100 px with y flipped:
// a click 75 px down the screen is a quarter of the way up the face.
const quad = { p: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] }
const camera = { project: (p) => [p[0] * 100, (1 - p[1]) * 100, 1] }
check('点在面的四分之一处 -> 0.25', Math.abs(api.faceHitY(quad, 50, 75, camera) - 0.25) < 1e-6,
  String(api.faceHitY(quad, 50, 75, camera)))
check('点在面的四分之三处 -> 0.75', Math.abs(api.faceHitY(quad, 50, 25, camera) - 0.75) < 1e-6,
  String(api.faceHitY(quad, 50, 25, camera)))
check('没有相机时退回中间，而不是崩掉', api.faceHitY(quad, 50, 25, null) === 0.5)
check('整个面高度为零时不除零', api.faceHitY({ p: [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]] }, 0, 0, camera) === 0.5)

// --- the words the user reads ----------------------------------------------
check('面的名字用游戏里的中文', api.labelOfValue('north') === '北' && api.labelOfValue('east') === '东')
check('条件用"是/否"，不写 true/false',
  api.labelOfValue('true') === '是' && api.labelOfValue('false') === '否')
check('没词可用的值照实写，不编',
  api.labelOfValue('weird_token') === 'weird_token' && api.labelOfAxis('weird_axis') === 'weird_axis')
check('conditional 有自己的名字，不会被叫成"朝向"',
  api.labelOfAxis('conditional') === '有条件' && api.labelOfAxis('facing') === '朝向')
check('摘要读得懂', api.variantSummary(cmdAxes, { conditional: 'true', facing: 'north' }) === '有条件 是 · 朝向 北',
  api.variantSummary(cmdAxes, { conditional: 'true', facing: 'north' }))
check('摘要里认不出的值照实写，不编',
  api.variantSummary(cmdAxes, { conditional: 'maybe' }) === '有条件 maybe',
  api.variantSummary(cmdAxes, { conditional: 'maybe' }))

// --- the thing that must not come back -------------------------------------
check('不再把复合变体键当按钮铺一排（那就是 40 个按钮的来源）',
  !/const chosen = typeof voxel\.variant === 'string'/.test(codeOnly)
  && !/'data-on': chosen === key \? '1' : '0'/.test(codeOnly))
check('每个属性一行，行标题用它自己的名字',
  /labelOfAxis\(axis\.name\)/.test(codeOnly) && /for \(const axis of axes\)/.test(codeOnly))
check('摆放时用的是点击那一刻推导出来的键，不是某个视图设置',
  /const placed = variantFor\(/.test(codeOnly) && /pick\.face/.test(codeOnly)
  && /target\.hitY/.test(codeOnly))

console.log(failures === 0 ? '\n全部通过' : '\n' + failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
