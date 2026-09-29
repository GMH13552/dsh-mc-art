#!/usr/bin/env node
/**
 * 模式的形状门禁：**只有一个** mc-studio，而且它刻意不带 `tool-cordis`。
 *
 * 为什么：曾经有两个同名模式（完整 / 无 Cordis）——因为 `tool-cordis` 注册的
 * Host Cordis inspect provider 是**进程级**的，和另一个已经用着它的会话不能共存
 * （实测：`Host Cordis inspect provider "Service" is already registered`，整行挂载失败）。
 * 面板改成"装进 profile 的真包"之后，这个模式不再需要那套工具集，于是两个并成一个，
 * 冲突的根源也一起消失。
 *
 * 谁要是把 `tool-cordis` 加回这个模式，或者又拷出一个变体，这道门禁就红。
 *
 *   node tools/check_presets.mjs
 *   node tools/check_presets.mjs --fault    # 注入一行启用的 tool-cordis，要求红
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const PRESETS = join(REPO, 'presets')
const FAULT = process.argv.includes('--fault')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

const dirs = existsSync(PRESETS) ? readdirSync(PRESETS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : []
check('仓库里只有一个 mc-studio 模式（没有变体、没有别名）',
  dirs.length === 1 && dirs[0] === 'mc-studio', JSON.stringify(dirs))

const presetFile = join(PRESETS, 'mc-studio', 'agent.cordis.yml')
let source = existsSync(presetFile) ? readFileSync(presetFile, 'utf8') : ''
if (FAULT) source = source.replace('# ── self-modification', "- id: tool-cordis\n  name: '@deepseek-ai/dsh-tool-cordis'\n\n# ── self-modification")

/** 某一行是否"启用"（它后面没有紧跟 disabled: true）。 */
function hasEnabledRow(text, id) {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== '- id: ' + id) continue
    const next = (lines[index + 1] ?? '').trim()
    const after = (lines[index + 2] ?? '').trim()
    if (next.startsWith('disabled: true') || after.startsWith('disabled: true')) continue
    return true
  }
  return false
}

check('模式里没有启用的 tool-cordis 行（否则会和别的会话抢进程级 provider）',
  !hasEnabledRow(source, 'tool-cordis'))
check('模式说明了为什么不带 tool-cordis（留一句话给后来的人）',
  source.indexOf('inspect provider') >= 0 && source.indexOf('进程级') >= 0)

const name = (/^name:\s*(.+)$/m.exec(readFileSync(join(PRESETS, 'mc-studio', 'preset.yml'), 'utf8')) ?? [])[1] ?? ''
check('模式名字存在且不含"无 Cordis"（那说明变体又回来了）',
  name.trim() !== '' && name.indexOf('无 Cordis') < 0, JSON.stringify(name))
check('人格里说清面板是"装好的包"（dsh-mc-art-panel）', source.indexOf('dsh-mc-art-panel') >= 0)
check('人格里不再教模型用 Cordis 工具动态发射面板',
  source.indexOf('发射一次并 `cordis_run`') < 0)

// 安装器与这里必须一致：别一个装两个、一个装一个。
const installer = readFileSync(join(REPO, 'install.mjs'), 'utf8')
check('安装器只装这一个模式', /PRESETS = \['mc-studio'\]/.test(installer))
check('安装器不再引用已删掉的变体（除非是在清理它）',
  !/mc-studio-nocordis/.test(installer) || /LEGACY_PRESETS[\s\S]{0,80}mc-studio-nocordis/.test(installer))

console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
