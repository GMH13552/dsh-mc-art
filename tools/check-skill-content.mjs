#!/usr/bin/env node
/**
 * 门禁：**skill 文档里写的工具路径，读者必须真的找得到。**
 *
 * 为什么：用户的原话是"顺便核查 skill 的内容，防止像之前一样找不到工具的情况"。
 * 已经复发过一次：文档让人跑 `bin\mc-art.cmd`，而那个文件在**另一个 skill 的根目录**下
 * —— 站在这份文档所在 skill 的根目录里的读者，照着抄就是"找不到工具"。
 *
 * 做法（判据和踩过的坑都在这里，别再踩一遍）：
 *   · 把文档当"读者会照抄的东西"扫：**fenced 代码块 + 行内代码**里的路径 token；
 *   · 只留**真的工具路径前缀**（`tools/ scripts/ bin/ panel/ skills/ python/ presets/
 *     mc_art/ docs/`），否则普通文件名与示例会被当成工具；
 *   · 每个 token 按**读者可能所在的根**依次解析：① 文档所在目录（README 叫人"在子目录里
 *     跑"，`../tools/...` 在那个语境下是对的）② 各个 skill 根（含另一个 skill 的根）
 *     ③ 仓库根 ④ 包根。**任何一个存在就算找到**。
 *   · `python -m <module>` 只查**确实属于我们的模块**（`mc_art` 在 mc-art skill 根下找，
 *     `mcart_*` 在 tools/ 或包内 python/ 找）；`pytest`/`pip`/`json` 这些第三方模块跳过。
 *   · 只扫**会被发布/被克隆者看到**的文件：仓库这边以 `git ls-files` 为准（`.team/`、
 *     `.pytest_cache` 之类自动不进），外加 mc-art 那个 skill 根（它不在本仓库里，但要发出去）。
 *   · 扩展名交替**长的在前**（`json|mjs|ps1|cmd|...|py|js|md`）：`js` 写在 `json` 前面会把
 *     `desk.json` 截成 `desk.js` —— 这个坑一次性报出过 806 条假阳性。
 *   · `$VAR/...`、`<...>`、含 `*`/`{}` 的 token 不查（shell 变量与占位符）。
 *
 *   node tools/check-skill-content.mjs
 *   node tools/check-skill-content.mjs --fault   # 往一份 skill 文档塞一行 tools/does_not_exist.py → 必须红 → 按字节还原
 */
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const FAULT = process.argv.includes('--fault')

/** 真·工具路径前缀：只有以它们开头的 token 才值得查。 */
const PREFIXES = ['tools', 'scripts', 'bin', 'panel', 'skills', 'python', 'presets', 'mc_art', 'docs']
/** 扩展名交替：**长的在前**（见文件头那个 806 条假阳性的坑）。 */
const EXTENSIONS = ['json', 'mjs', 'ps1', 'cmd', 'bat', 'sh', 'py', 'js', 'md', 'txt',
  'yml', 'yaml', 'java', 'gradle', 'properties', 'png', 'jar', 'html']
const TOKEN_RE = new RegExp(
  // `(?<![\\w-])`：npm 包名里的 `dsh-agent-presets/lib/index.js` 会被 `presets` 前缀误抓
  // （实测在 panel/README.md 里报过一条）；前面是 `-` 或词字符就不算"工具路径"。
  // `../tools/...` 前面是 `/`，仍然要抓（那条是文档所在目录的相对路径，是对的）。
  '(?<![\\w-])(?:' + PREFIXES.join('|') + ')[\\\\/][\\w.\\\\/-]*?\\.(?:' + EXTENSIONS.join('|') + ')(?![A-Za-z0-9])',
  'g')
/** `python -m a.b` 的模块名。 */
const MODULE_RE = /python3?\s+-m\s+([A-Za-z_][\w.]*)/g
/** 我们自己模块的所在地（其余第三方模块不查）。 */
const OUR_MODULES = {
  mc_art: ['skill'],                       // 在 mc-art skill 根下
  mcart_scan_refs: ['tools', 'pkg-python'],
  mcart_extract_block: ['tools', 'pkg-python'],
}

const SKILL_ROOTS = []
{
  const repoSkill = join(REPO, 'skills', 'mc-mod')
  if (existsSync(repoSkill)) SKILL_ROOTS.push(repoSkill)
  const artSource = process.env.MC_ART_SKILL_DIR ?? join(homedir(), '.dsh', 'skills', 'mc-art')
  if (existsSync(join(artSource, 'SKILL.md'))) SKILL_ROOTS.push(artSource)
  const packaged = join(REPO, 'panel', 'preset', 'mc-studio', 'skills')
  if (existsSync(packaged)) {
    for (const name of readdirSync(packaged)) {
      const full = join(packaged, name)
      if (statSync(full).isDirectory()) SKILL_ROOTS.push(full)
    }
  }
}

/** 会被读者看到的文档：仓库里 `git ls-files` 的 .md（`.team/` 等自动不进）+ mc-art skill 根。 */
function documents() {
  const done = spawnSync('git', ['ls-files', '-z', '*.md'], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (done.status !== 0) throw new Error('git ls-files 失败：' + String(done.stderr ?? '').trim())
  const out = String(done.stdout ?? '').split('\0').filter((name) => name !== '').map((name) => join(REPO, name))
  const artSource = process.env.MC_ART_SKILL_DIR ?? join(homedir(), '.dsh', 'skills', 'mc-art')
  if (existsSync(join(artSource, 'SKILL.md'))) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.md')) out.push(full)
      }
    }
    walk(artSource)
  }
  return out
}

/** 读者可能所在的根。任何一个存在就算找到。 */
function rootsFor(docAbs) {
  return [dirname(docAbs), ...SKILL_ROOTS, REPO, join(REPO, 'panel')]
}

function foundUnder(roots, token) {
  const cleaned = token.replace(/\\/g, '/')
  return roots.some((root) => existsSync(resolve(root, cleaned)))
}

function foundModule(roots, moduleName) {
  const places = OUR_MODULES[moduleName] ?? (moduleName.startsWith('mc_art.') ? ['skill'] : null)
  if (places === null) return null                    // 不是我们的模块 → 不查
  const head = moduleName.split('.')[0]
  const candidates = []
  if (places.includes('skill')) {
    for (const root of SKILL_ROOTS) {
      candidates.push(resolve(root, head, '__init__.py'), resolve(root, head + '.py'))
    }
  }
  if (places.includes('tools')) candidates.push(resolve(REPO, 'tools', head + '.py'))
  if (places.includes('pkg-python')) candidates.push(resolve(REPO, 'panel', 'python', head + '.py'))
  return candidates.some((path) => existsSync(path))
}

/** fenced 代码块 + 行内代码里的片段（行号一起带出来，报得出是哪儿）。 */
function codeSnippets(text) {
  const snippets = []
  let inFence = false
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) snippets.push({ line: index + 1, text: line })
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      snippets.push({ line: index + 1, text: match[1], inline: true })
    }
  }
  return snippets
}

function audit() {
  const hits = []
  const notes = []
  let tokens = 0
  const docs = documents()
  for (const docAbs of docs) {
    const text = readFileSync(docAbs, 'utf8')
    const label = relative(REPO, docAbs).replace(/\\/g, '/') + (docAbs.startsWith(REPO) ? '' : ' (skill 根外)')
    for (const snippet of codeSnippets(text)) {
      const body = snippet.text
      if (/\$[A-Za-z_{]/.test(body)) continue          // shell 变量路径不查
      for (const match of body.matchAll(TOKEN_RE)) {
        const token = match[0].replace(/[.,;:]+$/, '')
        if (/[<>*{}]/.test(token)) continue             // 占位符不查
        tokens += 1
        const roots = rootsFor(docAbs)
        if (foundUnder(roots, token)) {
          // 只在自己 skill 根之外解析得到 → 记一条提示（读者可能需要知道"哪个 skill 的根"）
          const own = SKILL_ROOTS.filter((root) => docAbs.startsWith(root))
          if (own.length > 0 && !own.some((root) => foundUnder([root], token))) {
            notes.push(`${label}:${snippet.line}  ${token}（只在别的根下解析得到）`)
          }
          continue
        }
        hits.push(`${label}:${snippet.line}  ${token}  ← 任何根都找不到`)
      }
      for (const match of body.matchAll(MODULE_RE)) {
        const moduleName = match[1]
        tokens += 1
        const ok = foundModule(rootsFor(docAbs), moduleName)
        if (ok === null) continue                        // 第三方模块（pytest/pip/...）跳过
        if (!ok) hits.push(`${label}:${snippet.line}  python -m ${moduleName}  ← 找不到这个模块（${OUR_MODULES[moduleName] ? '' : 'mc_art 前缀'})`)
      }
    }
  }
  return { hits, notes, tokens, docs: docs.length }
}

function main() {
  const result = audit()
  let failures = 0
  const check = (label, ok, detail) => {
    if (!ok) failures += 1
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  }

  if (FAULT) {
    const target = join(REPO, 'skills', 'mc-mod', 'references', 'workflow.md')
    if (!existsSync(target)) {
      console.log('  FAIL 夹具目标不存在：' + target)
      return 1
    }
    const before = readFileSync(target)
    try {
      const poisoned = before.toString('utf8') + '\n```bash\npython tools/does_not_exist.py\n```\n'
      writeFileSync(target, Buffer.from(poisoned, 'utf8'))
      const after = audit()
      const caught = after.hits.some((hit) => hit.includes('tools/does_not_exist.py'))
      check('往 skill 文档塞一行 `tools/does_not_exist.py` → 门禁必须红', caught,
        caught ? '' : '居然没抓到：' + JSON.stringify(after.hits.slice(0, 3)))
    } finally {
      writeFileSync(target, before)
    }
    check('还原后逐字节相同', readFileSync(target).equals(before),
      before.length + ' -> ' + readFileSync(target).length + ' 字节')
    console.log(failures === 0 ? '全部通过（对照成立：塞进去会红、还原是字节级的）' : failures + ' 项失败')
    return failures === 0 ? 0 : 1
  }

  console.log(`  扫了 ${result.docs} 份文档（仓库以 git ls-files 为准 + mc-art skill 根），` +
    `解析了 ${result.tokens} 个工具路径/模块 token`)
  console.log('  解析根：文档所在目录 → skill 根（含另一个 skill）→ 仓库根 → 包根；任何一个存在就算找到')
  if (result.hits.length === 0) {
    console.log('  OK   文档里写的每个工具路径都解析得到（读者照抄不会"找不到工具"）')
  } else {
    for (const hit of result.hits) console.log('  FAIL ' + hit)
    console.log(`${result.hits.length} 处找不到 —— 拒绝发布`)
    failures += result.hits.length
  }
  if (result.notes.length > 0) {
    console.log(`  —— 提示（不阻塞）：${result.notes.length} 处只在**别的根**下解析得到 ——`)
    for (const note of result.notes.slice(0, 10)) console.log('  · ' + note)
  }
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  return failures === 0 ? 0 : 1
}

process.exit(main())
