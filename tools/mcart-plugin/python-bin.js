// 哪一个是 Python？——和宿主里那段（host.js 的 PYTHON_CANDIDATES）同一个理由：
// Windows 上装完叫 python.exe 或 py，**没有 python3**；门禁脚本原来写死了 python3，
// 于是"在别人机器上跑门禁"第一行就挂。探一次并缓存。
const cp = require('child_process')

const CANDIDATES = [['python3', []], ['python', []], ['py', ['-3']]]
let cached

function pythonCommand() {
  if (cached !== undefined) return cached
  for (const [bin, prefix] of CANDIDATES) {
    const probe = cp.spawnSync(bin, prefix.concat(['-c', 'print(1)']), { encoding: 'utf8' })
    if (probe.status === 0 && String(probe.stdout || '').trim() === '1') {
      cached = { bin, prefix }
      return cached
    }
  }
  cached = null
  return null
}

function runPython(args, options) {
  const found = pythonCommand()
  if (found === null) throw new Error('找不到 Python（试过 ' + CANDIDATES.map((c) => c[0]).join(' / ') + '）')
  return cp.spawnSync(found.bin, found.prefix.concat(args), options)
}

module.exports = { pythonCommand, runPython, CANDIDATES }
