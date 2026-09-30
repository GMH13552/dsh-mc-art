#!/usr/bin/env node
/**
 * 「参考目录的候选」门禁：游戏目录检测必须**按平台**给候选，并且只报真实存在的。
 *
 * 为什么要有：这段代码原来是 WSL 形状的 —— 只看 `/root/.minecraft`、`/mnt/c/Users/<user>/…`、
 * `/home/<user>/…`。在原生 Windows 上它一条都不成立，于是设置页"检测到 … 用它"永远是空的；
 * 而"选择目录…"靠系统对话框，在某些环境里既不显示也不返回（shell 服务跑在非交互窗口站上时）。
 * 两者加起来 = 用户没有任何办法指定参考目录。实测症状：
 * 「我点选择目录没反应啊 也没有报错什么的」。
 *
 * 这里用 Windows 形状的环境变量造一棵假树，断言候选与命中；`--fault` 把候选换回老的
 * WSL 形状，要求它**找不到**（前提证明：老逻辑确实看不见这台机器）。
 *
 *   node tools/mcart-plugin/roots-test.js
 *   node tools/mcart-plugin/roots-test.js --fault
 */
const nodeFs = require('fs')
const nodePath = require('path')
// 注意：**不要**在这里 require('./run.js') —— 它在模块加载时就把宿主源码读进来了，
// 而故障注入要先把 MCART_HOST 指到改过的副本上。所以 run.js 留到 main 里再 require。

const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.roots-fixture')
const HOST = nodePath.join(__dirname, 'host.js')
const FAULT = process.argv.includes('--fault')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}

/** Windows 形状的一棵假树：%APPDATA%\.minecraft、工程旁边的 .minecraft、实例目录。 */
function buildFixture() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  const appdata = nodePath.join(WORK, 'AppData', 'Roaming')
  const home = nodePath.join(WORK, 'Users', 'probe')
  const project = nodePath.join(WORK, 'work')
  // 真的游戏目录（%APPDATA%\.minecraft）
  nodeFs.mkdirSync(nodePath.join(appdata, '.minecraft', 'versions', '1.18.2'), { recursive: true })
  nodeFs.mkdirSync(nodePath.join(appdata, '.minecraft', 'mods'), { recursive: true })
  // 工程旁边就有一个（模组开发工作区常见）
  nodeFs.mkdirSync(nodePath.join(project, '.minecraft', 'versions', '1.12.2'), { recursive: true })
  // 启动器的实例目录：真正的游戏目录是子目录，检测要能展开一层
  nodeFs.mkdirSync(nodePath.join(home, 'curseforge', 'minecraft', 'Instances', 'MyPack', 'versions', '1.16.5'), { recursive: true })
  nodeFs.mkdirSync(nodePath.join(home, 'curseforge', 'minecraft', 'Instances', 'MyPack', 'mods'), { recursive: true })
  // 一个"空壳实例"：没有 versions/mods，不该被当成游戏目录
  nodeFs.mkdirSync(nodePath.join(home, 'curseforge', 'minecraft', 'Instances', 'NotEmpty'), { recursive: true })
  return { appdata: appdata, home: home, project: project }
}

async function main() {
  const tree = buildFixture()
  // WSL 门禁跑在 Linux 上：把三个变量都指到假树里（检测读的就是它们）。
  process.env.APPDATA = tree.appdata.split(nodePath.sep).join('/')
  process.env.USERPROFILE = tree.home.split(nodePath.sep).join('/')
  process.env.HOME = tree.home.split(nodePath.sep).join('/')

  let source = nodeFs.readFileSync(process.env.MCART_HOST || HOST, 'utf8')
  const patched = source.replace('    function gameRootCandidates(near) {',
    "    function gameRootCandidates(near) {\n      return ['/root/.minecraft']")
  if (patched === source) {
    console.log('  FAIL 故障注入没生效：找不到 gameRootCandidates（门禁要跟着改）')
    process.exit(1)
  }
  if (FAULT) {
    const path = nodePath.join(WORK, 'fault-host.js')
    nodeFs.writeFileSync(path, patched)
    process.env.MCART_HOST = path
  }

  // run.js 在这一刻才加载：它要读的正是上面刚定好的 MCART_HOST。
  const { buildHandlers, localFsShim } = require('./run.js')
  const handlers = buildHandlers({ nodeFs: localFsShim })
  const env = await handlers['atlas.gameRoots']({ root: tree.project.split(nodePath.sep).join('/') })
  const at = (value) => String(value).split(nodePath.sep).join('/')
  const detected = (env.detected || []).map(at)
  const candidates = (env.candidates || []).map(at)
  if (process.env.MCART_SHOW_ROOTS === '1') {
    console.log('  [debug] candidates=' + JSON.stringify(candidates))
    console.log('  [debug] detected=' + JSON.stringify(detected))
  }

  if (FAULT) {
    // 前提证明：老的 WSL 形状逻辑在这台"Windows"上一条候选都不成立。
    const sawWindows = detected.some((item) => item.indexOf(at(tree.appdata)) === 0 || item.indexOf(at(tree.project)) === 0)
    check('老逻辑（只看 /root、/mnt/c、/home）确实找不到这台机器上的游戏目录', sawWindows !== true,
      JSON.stringify(detected))
    nodeFs.rmSync(WORK, { recursive: true, force: true })
    console.log(failures === 0 ? '全部通过（前提成立：这是必须修的原因）' : failures + ' 项失败')
    process.exit(failures === 0 ? 0 : 1)
  }

  check('候选里给了 %APPDATA%\\.minecraft', candidates.some((item) => item === at(tree.appdata) + '/.minecraft'),
    JSON.stringify(candidates))
  check('候选里给了工程旁边的 .minecraft / run',
    candidates.some((item) => item === at(tree.project) + '/.minecraft') &&
    candidates.some((item) => item === at(tree.project) + '/run'), JSON.stringify(candidates))
  check('真的存在的 %APPDATA%\\.minecraft 被检出', detected.some((item) => item === at(tree.appdata) + '/.minecraft'),
    JSON.stringify(detected))
  check('工程旁边的 .minecraft 被检出', detected.some((item) => item === at(tree.project) + '/.minecraft'),
    JSON.stringify(detected))
  check('启动器实例容器被展开到子目录（真正能读的那个）',
    detected.some((item) => item.indexOf('Instances/MyPack') > 0), JSON.stringify(detected))
  check('不存在的候选不会被报出来（只报 stat 得到的）',
    !detected.some((item) => item === at(tree.home) + '/.minecraft'), JSON.stringify(detected))
  check('没有 versions/mods 的空壳实例不算游戏目录',
    !detected.some((item) => item.indexOf('NotEmpty') >= 0), JSON.stringify(detected))
  check('最多给 5 个（面板上是一行一个按钮）', detected.length <= 5, String(detected.length))
  check('报上了平台（诊断时第一眼要看的）', env.platform !== undefined && env.platform !== null, String(env.platform))

  nodeFs.rmSync(WORK, { recursive: true, force: true })
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => { console.error('THREW', error); process.exit(1) })
