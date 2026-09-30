#!/usr/bin/env node
/**
 * 「新建项目」的门禁：空目录 → 建骨架 → 面板认得它，而且**一个模组一个命名空间**。
 *
 * 为什么要有：这是新手第一步。宿主认项目的规则是"目录里有 mc-art.atlas.json
 * **或** pack/assets/<命名空间>/"——但**只有 atlas、没有资源目录**时 `build()` 会跳过它
 * （命名空间推不出来）。所以"建完能不能被认出来"必须有人盯着，故障注入那条就是证明。
 *
 *   node tools/mcart-plugin/project-test.js
 *   node tools/mcart-plugin/project-test.js --fault   # **证明前提**：只写 atlas、不建 pack 时
 *      项目认不出来。前提若被推翻（居然认出来了）这条就会红 —— 它证明"骨架是必需的"。
 */
const nodeFs = require('fs')
const nodePath = require('path')
const { handlers } = require('./run.js')

const REPO = nodePath.resolve(__dirname, '..', '..')
const WORK = nodePath.join(REPO, 'tools', 'mcart-plugin', '.project-fixture')
const FAULT = process.argv.includes('--fault')

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label + (ok || detail === undefined ? '' : '  -> ' + detail))
}
const scan = async () => (await handlers['atlas.scan']({ root: WORK })).projects

async function main() {
  nodeFs.rmSync(WORK, { recursive: true, force: true })
  nodeFs.mkdirSync(WORK, { recursive: true })

  check('空目录里没有项目（面板该给引导，而不是报错）', (await scan()).length === 0)

  if (FAULT) {
    // 只写 atlas、不建 pack 骨架 —— 这正是"看起来成功但其实认不出来"的写法。
    const dir = nodePath.join(WORK, 'faultproj')
    nodeFs.mkdirSync(dir, { recursive: true })
    nodeFs.writeFileSync(nodePath.join(dir, 'mc-art.atlas.json'),
      JSON.stringify({ schema: 'mc-art.atlas/1', namespace: 'faultproj', biomes: [], structures: [], entities: [], blocks: [] }))
    const found = await scan()
    check('只有 atlas 的目录认不出来（所以骨架是必需的）', found.length === 0,
      JSON.stringify(found.map((p) => p.id)))
    nodeFs.rmSync(WORK, { recursive: true, force: true })
    console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
    process.exit(failures === 0 ? 0 : 1)
  }

  const made = await handlers['atlas.createProject']({ root: WORK, id: 'fleshland', namespace: 'fleshland' })
  check('建项目成功', made && made.created === true, JSON.stringify(made))
  const after = await scan()
  check('扫得到刚建的项目，命名空间正确',
    after.length === 1 && after[0].id === 'fleshland' && after[0].namespace === 'fleshland',
    JSON.stringify(after.map((p) => p.id + ':' + p.namespace)))
  check('骨架目录真的落在盘上',
    nodeFs.existsSync(nodePath.join(WORK, 'fleshland', 'pack', 'assets', 'fleshland', 'textures', 'block')),
    nodePath.join(WORK, 'fleshland', 'pack'))

  const again = await handlers['atlas.createProject']({ root: WORK, id: 'fleshland' })
  check('同一目录再建一次 → 拒绝（不会覆盖）', again && typeof again.error === 'string', JSON.stringify(again))

  // 真实场景：有人手写了 pack/assets/alpha（没有 atlas），这时不许再给它塞第二个命名空间。
  nodeFs.mkdirSync(nodePath.join(WORK, 'manual', 'pack', 'assets', 'alpha'), { recursive: true })
  const other = await handlers['atlas.createProject']({ root: WORK, id: 'manual', namespace: 'beta' })
  check('目录里已有别的命名空间 → 拒绝（一个模组只用一个）',
    other && typeof other.error === 'string' && other.error.indexOf('命名空间') >= 0, JSON.stringify(other))
  const same = await handlers['atlas.createProject']({ root: WORK, id: 'manual', namespace: 'alpha' })
  check('用已有的那个命名空间 → 允许（不制造第二个）', same && same.created === true, JSON.stringify(same))

  const bad = await handlers['atlas.createProject']({ root: WORK, id: '../escape' })
  check('id 里的路径符号被拒（不许写到根目录外面）', bad && typeof bad.error === 'string', JSON.stringify(bad))

  const badNs = await handlers['atlas.createProject']({ root: WORK, id: 'okid', namespace: 'Bad-Name' })
  check('非法命名空间被拒', badNs && typeof badNs.error === 'string', JSON.stringify(badNs))

  nodeFs.rmSync(WORK, { recursive: true, force: true })
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((error) => { console.error('THREW', error); process.exit(1) })
