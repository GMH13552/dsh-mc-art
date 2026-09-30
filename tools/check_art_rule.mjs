#!/usr/bin/env node
/**
 * 门禁：mc-mod 必须**明说"纹理不许手画"**，而且说在流程里、说在验收标准里。
 *
 * 为什么要有这条：用户实测过一次真事故 —— agent 读了 mc-art skill、确认 CLI 能跑
 * （只跑了一次 `--help`），然后**用 PIL 手画了两张贴图**。两次独立手绘 → 背景/调色板
 * 毫无关系（"这雾石和矿石的背景纹理完全不同啊？你是不是没用 mc-art"）。
 * 会话日志里的计数就是证据：`PIL` 18 次、`Image.new` 9 次、`ImageDraw` 4 次，
 * 而引擎的 `index-vanilla` / `evidence` 一次都没跑过。
 *
 * 旧的 stage 2 写的是"Use the mc-art skill… you write a plan"——那是**介绍**，不是禁令，
 * 一个能一行写 PIL 的模型完全可以绕过。所以这条门禁钉三件事：
 *   1. 顶层规则里有一条"手写的 PNG 不算交付"；
 *   2. 流程 stage 2 里有**前置条件**（参考目录必须是同一版本，没设就停下来说）；
 *   3. stage 2 里有**循环命令**与**验收标准**（plan + sprite.png + 与参考的对比）。
 *
 *   node tools/check_art_rule.mjs          # 断言三件事都在
 *   node tools/check_art_rule.mjs --fault  # 把"禁令"那句话删掉，要求门禁红
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SKILL = join(ROOT, 'skills', 'mc-mod', 'SKILL.md')
const WORKFLOW = join(ROOT, 'skills', 'mc-mod', 'references', 'workflow.md')
const FAULT = process.argv.includes('--fault')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

let skill = readFileSync(SKILL, 'utf8')
let workflow = readFileSync(WORKFLOW, 'utf8')
if (FAULT) {
  // 故障注入：把最关键的那句禁令拿掉，其余都留着 —— 门禁必须因此变红。
  const before = workflow
  workflow = workflow.replace('**Rule: you do not draw textures.**', '### Draw the textures')
  if (workflow === before) {
    console.log('  FAIL --fault 没生效：workflow.md 里找不到那句禁令（门禁要跟着改）')
    process.exit(1)
  }
}

console.log('--- mc-mod 必须教"美术走引擎"，而且不能只是一句介绍')

// 1) 顶层规则
check('顶层规则里有"手写的 PNG 不算交付"这一条',
  /hand-written PNG is not a delivery/.test(skill),
  '（SKILL.md 的规则段里没有这句 —— 模型会以为手画也行）')
check('顶层规则点名了"不许 PIL/numpy/手放像素"',
  /PIL`\/`numpy`\/hand-placed pixels|PIL\/numpy/.test(skill),
  '（没有具体点名，禁令就落不到那个最常见的绕法上）')
check('顶层规则说了"为什么要"（独立手绘 → 背景/调色板互不相干）',
  /unrelated backgrounds and palettes/.test(skill))

// 2) 流程里的前置条件
check('stage 2 有前置条件：参考目录必须是同一版本',
  /Precondition/.test(workflow) && /same version/.test(workflow),
  '（没有前置条件，模型会"就地编"美术）')
check('stage 2 说了参考目录在哪看（mc-art.settings.json / ⚙ 参考目录）',
  /mc-art\.settings\.json/.test(workflow) && /参考目录/.test(workflow))
check('stage 2 说清"没设参考目录就停下来说"，而不是将就',
  /say so and stop|stop.*do not "make do"/i.test(workflow))

// 3) 循环与验收
for (const needle of ['index-vanilla', 'evidence', 'render --plan', 'sprite.png', 'outputs/']) {
  check('stage 2 的循环里有 `' + needle + '`', workflow.indexOf(needle) >= 0)
}
check('stage 2 的验收要求三样（plan 文件 + 渲染图 + 与参考的对比）',
  /Acceptance \(all three/.test(workflow) && /plan file/.test(workflow),
  '（验收不写清，stage 2 就会以"我画好了"结束）')
check('stage 2 点了"同族一致性"（石头和它的矿石共享背景/调色板）',
  /Family consistency is the point/.test(workflow))
check('禁令本身在（不是只写了循环）', /you do not draw textures/.test(workflow))

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
