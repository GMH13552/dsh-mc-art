#!/usr/bin/env node
/**
 * 两个 mc-studio 模式**只许差在该差的地方**。
 *
 * 为什么需要它：`mc-studio-nocordis` 是同一份 composition 把 `tool-cordis` 那一行
 * disabled 得到的变体（那个模式不占用进程级的 Cordis 工具集，所以能和别的会话并存）。
 * 这个变体曾经是我手工拷的，于是它比完整版旧：人格里少了"先确认面板在不在"那段，
 * 而它恰恰是发射不了面板的那个模式——**两份同名、内容还不一致**，用户在名单里看到
 * 两个一样的东西，谁也不知道该选哪个。
 *
 * 现在的规矩：两份文件**逐字节相同，只多一行 `disabled: true`**；人格里关于面板那段
 * 必须在两个文件里逐字相同且各自成立（有 Cordis 工具就发射，没有就请用户换模式）。
 * 谁要是只改了一份，这道门禁当场红。
 *
 *   node tools/check_preset_variants.mjs            # 正常跑
 *   node tools/check_preset_variants.mjs --fault    # 注入一处漂移，要求它红
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const MAIN = join(REPO, 'presets', 'mc-studio')
const VARIANT = join(REPO, 'presets', 'mc-studio-nocordis')
const FAULT = process.argv.includes('--fault')

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  OK   ' + name)
  else { failures += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ← ' + detail)) }
}

/** 两份都读一遍；变体那一行 disabled 是唯一允许的差异。 */
function readBoth() {
  const files = ['agent.cordis.yml', 'preset.yml']
  const out = {}
  for (const file of files) {
    const a = join(MAIN, file)
    const b = join(VARIANT, file)
    out[file] = {
      main: existsSync(a) ? readFileSync(a, 'utf8') : null,
      variant: existsSync(b) ? readFileSync(b, 'utf8') : null,
    }
  }
  return out
}

const files = readBoth()
check('两个模式目录都在，且各有 agent.cordis.yml / preset.yml',
  files['agent.cordis.yml'].main !== null && files['agent.cordis.yml'].variant !== null &&
  files['preset.yml'].main !== null && files['preset.yml'].variant !== null)

const mainText = files['agent.cordis.yml'].main ?? ''
let variantText = files['agent.cordis.yml'].variant ?? ''

// 故障注入：把变体改得和完整版"多一处不同"，门禁必须抓住。
if (FAULT && variantText !== '') {
  variantText = variantText.replace('- id: agent-instructions', '- id: agent-instructions-renamed-by-fault')
}

/** 去掉那唯一允许的一行之后，两份必须逐字节相同。 */
const stripAllowed = (text) => text
  .replace(/^(- id: tool-cordis\n  name: '@deepseek-ai\/dsh-tool-cordis'\n)  disabled: true\n/m, '$1')

const stripMain = stripAllowed(mainText)
const stripVariant = stripAllowed(variantText)
const disabledCount = (mainText.match(/^  disabled: true$/gm) ?? []).length
check('完整版里没有 disabled 行（它是"什么都能干"的那个）', disabledCount === 0, disabledCount + ' 行')

const variantDisabled = (variantText.match(/^  disabled: true$/gm) ?? []).length
check('变体里恰好只有 1 行 disabled（就是 tool-cordis 那一行）', variantDisabled === 1,
  variantDisabled + ' 行')

check('去掉那一行之后，两份 composition 逐字节相同', stripMain === stripVariant,
  stripMain === stripVariant ? '' : '第一个不同的位置 ' +
    (() => {
      const n = Math.min(stripMain.length, stripVariant.length)
      for (let i = 0; i < n; i++) if (stripMain[i] !== stripVariant[i]) return i + ' 处：' +
        JSON.stringify(stripMain.slice(i - 40, i + 40)) + ' ≠ ' + JSON.stringify(stripVariant.slice(i - 40, i + 40))
      return '长度不同：' + stripMain.length + ' vs ' + stripVariant.length
    })())

// 两个名字必须能区分，否则名单里又是两个一样的东西。
function presetName(text) {
  const hit = /^name:\s*(.+)$/m.exec(text ?? '')
  return hit === null ? null : hit[1].trim()
}
const mainName = presetName(files['preset.yml'].main)
const variantName = presetName(files['preset.yml'].variant)
check('两个模式的名字都存在', mainName !== null && variantName !== null,
  JSON.stringify([mainName, variantName]))
check('两个模式的名字不一样（用户在名单里得能分辨）', mainName !== null && mainName !== variantName,
  JSON.stringify([mainName, variantName]))
check('变体名字里点明了它关了 Cordis', variantName !== null && /无 Cordis/.test(variantName), String(variantName))

// 人格那段必须在两份里逐字相同，而且要把两种情况都说到。
const launchLine = /会话开始时先确认面板在不在/
check('人格里都写了"会话开始先确认面板在不在"',
  launchLine.test(mainText) && launchLine.test(variantText))
check('那段把"有 Cordis 工具就自己发射 / 没有就请用户换模式"都写了',
  /发射一次并 `cordis_run`/.test(mainText) && /发射不了面板/.test(mainText) &&
  mainText.includes('发射一次并 `cordis_run`') && mainText.includes('发射不了面板'),
  '缺了其中一种情况')

console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
