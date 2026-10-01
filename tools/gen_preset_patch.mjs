#!/usr/bin/env node
/**
 * 生成**桌面代**（dsh 0.2.0-rc.x）要的那段预设补丁 —— 唯一真相是
 * `presets/mc-studio/agent.cordis.yml` + `preset.yml`。
 *
 * 为什么要生成、而不是手写：两代 DSH 送达预设的方式不一样。
 *
 *   * 0.1.x：一个预设 = `~/.dsh/.agent-presets/<id>/` 目录（或 `agent-presets.roots`
 *     指的目录），里面是 `preset.yml` + `agent.cordis.yml`；
 *   * 0.2.0-rc.x（桌面端）：一个预设 = **组合里的一行**
 *     `@deepseek-ai/dsh-agent-preset`，`config.plugins` 里放这个人格要挂的行。
 *
 * 所以「同一个模式两种送达」只能这样实现：目录那份照旧（`presets/mc-studio/`），
 * 再加一段把 `agent.cordis.yml` 的**每一行原样缩进**到 `plugins:` 下面的补丁。
 * 手抄过一次（294 行），马上就漂了 —— persona 改了、插件行增删了，补丁还停在旧版本。
 * 这个脚本做的就是那一件事：**缩进 + 包壳**，不解析 YAML、不重排、不改一个字符，
 * 于是注释、块标量（`prefix: |-`）、`!!js` 表达式都逐字符保留。
 *
 *   node tools/gen_preset_patch.mjs                 # 打印（写进 desktop-generation.patch.yml 的内容）
 *   node tools/gen_preset_patch.mjs --write         # 写进 presets/mc-studio/desktop-generation.patch.yml
 *   node tools/gen_preset_patch.mjs --check         # 与磁盘比对，漂移就非零退出
 *   node tools/gen_preset_patch.mjs --row           # 只打印要嵌进 panel/cordis.patch.yml 的那一段（带标记）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const PRESET_DIR = join(REPO, 'presets', 'mc-studio')
const SOURCE = join(PRESET_DIR, 'agent.cordis.yml')
const PRESET_YML = join(PRESET_DIR, 'preset.yml')
const TARGET = join(PRESET_DIR, 'desktop-generation.patch.yml')
/** 给 check_presets.mjs 用（它要独立核对同一份生成物）。 */
export const TARGET_FILE = TARGET
/** 包自己的补丁：同一段生成物嵌在它的 `- insert:` 列表里（标记之间，由本脚本维护）。 */
const PANEL_PATCH = join(REPO, 'panel', 'cordis.patch.yml')

/** 预设 id 与它在桌面代组合里的行 id（实测约定：行 id = `preset-<preset id>`）。 */
export const PRESET_ID = 'mc-studio'
export const ROW_ID = 'preset-' + PRESET_ID
/** 排序值：用户预设排在出厂预设之后。 */
export const PRESET_ORDER = 100
/** `plugins:` 下面的行，缩进 10 空格（和出厂那种一行一个预设的写法对齐）。 */
const PLUGIN_INDENT = ' '.repeat(10)
/** 嵌进 panel/cordis.patch.yml 的 `- insert:` 列表时，行缩进 4 空格。 */
const ROW_INDENT = ' '.repeat(4)
export const BEGIN_MARK = '# === BEGIN GENERATED: preset-' + PRESET_ID + '（tools/gen_preset_patch.mjs，不要手改） ==='
export const END_MARK = '# === END GENERATED: preset-' + PRESET_ID + ' ==='

/**
 * skill 目录怎么指。
 *
 * 目录那份（`agent.cordis.yml` 里）用的是 `new URL('skills/', baseUrl)` —— 对目录代是对的，
 * 因为 `baseUrl` 就是预设自己的目录。桌面代里这一行被**组合**持有，`baseUrl` 的作用域
 * 未必还是"预设目录"，所以这里换成一个两代都成立的写法：**从 `baseUrl` 出发解析
 * `dsh-mc-art-panel/package.json`**，再从包目录拼 `preset/mc-studio/skills`。
 * Node 的模块解析从"预设目录"往上走也会落到 profile 的 `node_modules` 里找到本包，
 * 所以 baseUrl 是 profile 目录还是预设目录都成立；解析不到时退回 URL 写法。
 */
const SKILL_PATH_OLD = "- !!js \"process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))\""
const SKILL_PATH_NEW = "- !!js \"(() => { const cpu = process.getBuiltinModule('node:path'); " +
  "const req = process.getBuiltinModule('node:module').createRequire(baseUrl); " +
  "try { return cpu.join(cpu.dirname(req.resolve('dsh-mc-art-panel/package.json')), 'preset', 'mc-studio', 'skills') } " +
  "catch (error) { return process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl)) } })()\""

/**
 * 只在"这一代真的有 `@deepseek-ai/dsh-agent-preset`"时才插这一行。
 * 老一代（0.1.x）没有这个包，插进去会挂载失败；`disabled` 里的 try/catch 保证
 * 探测本身绝不把整条 patch 打挂。
 */
const DISABLED_PROBE = '!!js "(() => { try { ' +
  "process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json'); " +
  'return false } catch (error) { return true } })()"'

/** 从 preset.yml 里取一个标量（只认 `key: value` 这种单行，够用了，而且不引依赖）。 */
export function presetField(text, key, fallback = '') {
  const match = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(text)
  return match === null ? fallback : match[1].trim()
}

/** YAML 单引号标量：永远合法，且不解释 `{{…}}`、`：`、`#` 这些字符。 */
export function yamlScalar(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** `agent.cordis.yml` 的正文 → `plugins:` 下面那一段（整体缩进，内容一字不改）。 */
export function pluginRows(agentText) {
  let text = agentText
  if (!text.includes(SKILL_PATH_OLD)) {
    throw new Error('agent.cordis.yml 里找不到 skill 目录那一行（生成器按它做替换，改了它就要同步改这里）：\n  ' +
      SKILL_PATH_OLD)
  }
  text = text.replace(SKILL_PATH_OLD, SKILL_PATH_NEW)
  return text.replace(/\s+$/, '').split('\n')
    .map((line) => (line === '' ? '' : PLUGIN_INDENT + line))
    .join('\n')
}

/**
 * 独立补丁文件的内容（`presets/mc-studio/desktop-generation.patch.yml`）：
 * 用户把它整段追加到 `<profile>/cordis.patch.yml` 末尾即可。
 */
export function generate() {
  const agent = readFileSync(SOURCE, 'utf8')
  const preset = readFileSync(PRESET_YML, 'utf8')
  const name = presetField(preset, 'name', 'MC 模组工作室')
  const description = presetField(preset, 'description')
  return [
    '# 生成物：由 tools/gen_preset_patch.mjs 从 presets/mc-studio/{preset.yml,agent.cordis.yml} 生成。',
    '# **不要手改**；改预设请改那两份来源，然后 `node tools/gen_preset_patch.mjs --write`。',
    '#',
    '# 这一份是给**桌面代**（dsh 0.2.0-rc.x）的：那一代不扫 .agent-presets 目录，',
    '# 一个预设就是组合里的一行（@deepseek-ai/dsh-agent-preset + config.plugins）。',
    '# 装 npm 包的方式已由包自己的 cordis.patch.yml 带这段（同一份生成物），',
    '# 这个文件是"不想装包、手工追加"时的等价物：把下面全部内容追加到',
    '# <你的 profile>/cordis.patch.yml 末尾，然后重启。不生效就删掉追加的部分。',
    '#',
    '# 行 id 用 preset-<预设 id>，config.id 才是预设 id（实测的两代约定）。',
    '',
    '- insert:',
    ROW_INDENT + '- id: ' + ROW_ID,
    ROW_INDENT + '  name: ' + yamlScalar('@deepseek-ai/dsh-agent-preset'),
    ROW_INDENT + '  # 只有这一代真的有 @deepseek-ai/dsh-agent-preset 时才挂载。',
    ROW_INDENT + '  disabled: ' + DISABLED_PROBE,
    ROW_INDENT + '  config:',
    ROW_INDENT + '    id: ' + PRESET_ID,
    ROW_INDENT + '    name: ' + yamlScalar(name),
    ROW_INDENT + '    description: ' + yamlScalar(description),
    ROW_INDENT + '    order: ' + PRESET_ORDER,
    ROW_INDENT + '    plugins:',
    pluginRows(agent),
    '',
  ].join('\n')
}

/**
 * 嵌进 `panel/cordis.patch.yml` 的 `- insert:` 列表时的那一段（带起止标记，好让
 * check_presets.mjs 提出来逐字符比对）。
 */
export function rowBlock() {
  const full = generate()
  const lines = full.split('\n')
  // 从第一行 `    - id: preset-…` 到最后一行（去掉尾部空行），前面补标记。
  const start = lines.findIndex((line) => line === ROW_INDENT + '- id: ' + ROW_ID)
  if (start < 0) throw new Error('生成结果里找不到预设行 —— 生成器的形状变了')
  const body = lines.slice(start).join('\n').replace(/\s+$/, '')
  return [BEGIN_MARK, body, END_MARK].join('\n')
}

/**
 * 把生成的那一段（含标记）替换进 `panel/cordis.patch.yml` 的标记之间。
 * 标记不在就**抛**，绝不"没找到就当成功"—— 那正是漂移最喜欢的形状。
 */
export function splicePanelPatch(text, block) {
  const begin = text.split('\n').findIndex((line) => line.includes(BEGIN_MARK.trim()))
  const end = text.split('\n').findIndex((line) => line.includes(END_MARK.trim()))
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error('panel/cordis.patch.yml 里找不到生成标记（' + BEGIN_MARK + ' / ' + END_MARK +
      '）—— 手写过一次之后标记被删了？把两行标记放回去再跑本脚本。')
  }
  const lines = text.split('\n')
  return lines.slice(0, begin).concat(block.split('\n')).concat(lines.slice(end + 1)).join('\n')
}

/** 从 `panel/cordis.patch.yml` 里把标记之间那一段提出来（check 用）。 */
export function extractPanelPatch(text) {
  const lines = text.split('\n')
  const begin = lines.findIndex((line) => line.includes(BEGIN_MARK.trim()))
  const end = lines.findIndex((line) => line.includes(END_MARK.trim()))
  if (begin < 0 || end < 0 || end <= begin) return null
  return lines.slice(begin, end + 1).join('\n')
}

function compare(label, disk, expected) {
  if (disk === expected) {
    console.log('  OK   ' + label + ' 与生成结果逐字符相同（' + disk.length + ' 字符）')
    return true
  }
  const limit = Math.min(disk.length, expected.length)
  let at = 0
  while (at < limit && disk[at] === expected[at]) at += 1
  console.log('  FAIL ' + label + ' 与 presets/mc-studio 漂移了：磁盘 ' + disk.length +
    ' 字符 / 生成 ' + expected.length + ' 字符，第一处不同在第 ' + at + ' 字符\n' +
    '       磁盘 ' + JSON.stringify(disk.slice(at, at + 60)) + '\n' +
    '       生成 ' + JSON.stringify(expected.slice(at, at + 60)))
  return false
}

function main(argv) {
  const check = argv.includes('--check')
  const write = argv.includes('--write')
  const row = argv.includes('--row')
  const text = row ? rowBlock() + '\n' : generate()

  if (check) {
    let ok = true
    if (!existsSync(TARGET)) {
      console.log('  FAIL ' + TARGET + ' 不存在（跑 node tools/gen_preset_patch.mjs --write）')
      ok = false
    } else {
      ok = compare('presets/mc-studio/desktop-generation.patch.yml', readFileSync(TARGET, 'utf8'), text) && ok
    }
    const panel = readFileSync(PANEL_PATCH, 'utf8')
    const embedded = extractPanelPatch(panel)
    if (embedded === null) {
      console.log('  FAIL panel/cordis.patch.yml 里找不到生成标记')
      ok = false
    } else {
      ok = compare('panel/cordis.patch.yml（标记之间那段）', embedded, rowBlock()) && ok
    }
    console.log(ok ? '全部通过' : '漂移 —— 跑 node tools/gen_preset_patch.mjs --write 重新生成')
    return ok ? 0 : 1
  }

  if (write) {
    writeFileSync(TARGET, text)
    console.log('已写入 ' + TARGET + '（' + text.length + ' 字符）')
    const panel = readFileSync(PANEL_PATCH, 'utf8')
    const updated = splicePanelPatch(panel, rowBlock())
    if (updated === panel) console.log('panel/cordis.patch.yml 里的那一段已经是最新的')
    else {
      writeFileSync(PANEL_PATCH, updated)
      console.log('已更新 ' + PANEL_PATCH + '（标记之间那段）')
    }
    return 0
  }
  process.stdout.write(text)
  return 0
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gen_preset_patch.mjs')) {
  process.exit(main(process.argv.slice(2)))
}
