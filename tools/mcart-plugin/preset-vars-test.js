// 预设里的提示词模板变量，只能是**这一代真的注册了**的那些。
//
// 线上事故（0.3.3 及以前）：`mc-studio` 预设的 persona 段落写了 `{{cwd}}`，而当前 DSH
// 在 `deployment:persona-prefix` 只注册 `provider` / `model` —— 渲染提示词时直接抛
// unknown prompt variable，**用这个模式的会话整轮跑不起来**（用户看到的是"处理失败"）。
// 这类错误完全静态可查，所以钉成门禁：预设与随包补丁里出现的每个 {{var}} 都必须在
// 白名单里；出现一个没注册的，发版前就红。
//
//   node tools/mcart-plugin/preset-vars-test.js
//   node tools/mcart-plugin/preset-vars-test.js --fault   # 注入一个未知变量，必须红
const fs = require('fs')
const path = require('path')

const REPO = path.resolve(__dirname, '..', '..')

/** 这一代（DSH 0.2.1-rc.x）在 persona 段落注册的变量。新增白名单要拿实测说话。 */
const ALLOWED = new Set(['provider', 'model'])

/** 所有会被"当成预设挂载"或随包发出去的 YAML。 */
const FILES = [
  'presets/mc-studio/agent.cordis.yml',
  'presets/mc-studio/preset.yml',
  'presets/mc-studio/desktop-generation.patch.yml',
  'panel/cordis.patch.yml',
  'panel/preset/mc-studio/agent.cordis.yml',
  'panel/preset/mc-studio/preset.yml',
  'panel/preset/mc-studio/desktop-generation.patch.yml',
]

const VARIABLE = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || !detail ? '' : '  -> ' + detail))
}

/** 收集一个文本里出现过的变量名。 */
function variablesIn(text) {
  const found = new Set()
  let match
  VARIABLE.lastIndex = 0
  while ((match = VARIABLE.exec(text)) !== null) found.add(match[1])
  return found
}

let scanned = 0
for (const relative of FILES) {
  const file = path.join(REPO, relative)
  if (!fs.existsSync(file)) continue          // 生成物可能还没生成；由 verify-build 管存在性
  scanned += 1
  const text = fs.readFileSync(file, 'utf8')
  const unknown = [...variablesIn(text)].filter((name) => !ALLOWED.has(name)).sort()
  check(relative + ' 的模板变量都在白名单里', unknown.length === 0,
    unknown.length === 0 ? '' : '未注册：' + unknown.map((name) => '{{' + name + '}}').join('、'))
}

check('至少扫到了一批预设文件（门禁不是空转）', scanned >= 3, scanned + ' 个文件')

// 反向夹具：往一份预设里塞一个未注册变量，**这条门禁本身必须变红**（退出码 1）。
if (process.argv.indexOf('--fault') >= 0) {
  const file = path.join(REPO, 'presets/mc-studio/agent.cordis.yml')
  const poisoned = fs.readFileSync(file, 'utf8') + '\n# fault: {{cwd}}\n'
  const unknown = [...variablesIn(poisoned)].filter((name) => !ALLOWED.has(name))
  // 期望"没有未注册变量" —— 注入之后必然不成立，于是失败计数 +1、退出码非零。
  check('故障注入（塞入未注册变量）后判据必须红', unknown.length === 0,
    '检出未注册变量：' + unknown.map((name) => '{{' + name + '}}').join('、'))
}

console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
