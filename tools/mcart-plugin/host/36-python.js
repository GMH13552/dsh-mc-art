    async function findScanner(start) { return await findTool(start, SCAN_SCRIPT) }

    /** 包自带的引擎 / 用户 skills 目录里的脚本候选（顺序 = 优先次序）。 */
    function skillToolCandidates(relative) {
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        const trimmed = value.charAt(value.length - 1) === '/' ? value.slice(0, value.length - 1) : value
        if (trimmed !== '' && out.indexOf(trimmed) < 0) out.push(trimmed)
      }
      const dir = moduleDirOf()
      if (dir !== '') {
        const pkg = parentOf(dir) || ''                       // <包>/lib → <包>
        const above = pkg === '' ? '' : (parentOf(pkg) || '')  // <包> → profile / 仓库根
        const base = relative.slice(relative.lastIndexOf('/') + 1)
        // **随包的那份**：<包>/python/mcart_scan_refs.py —— 安装后的正常形态，也是唯一
        // 保证"别人的机器上也有"的那一份。两个脚本只依赖标准库，所以随包带一份就够
        // （原来是"项目必须恰好在仓库里"才找得到；verify-build 会挡住它和仓库里那份漂移）。
        push(pkg + '/python/' + base)
        push(above + '/python/' + base)
        // 在仓库里直接跑的形态（最后兜底：本仓库根目录下的 tools/）
        push(above + '/' + relative)
        // 旧形态：万一有人把引擎放在 skill 目录里
        push(pkg + '/preset/mc-studio/skills/mc-art/' + relative)
        push(above + '/preset/mc-studio/skills/mc-art/' + relative)
        push(above + '/skills/mc-art/' + relative)
      }
      const named = envOf('MC_ART_SKILL_DIR')
      if (named !== '') push(named + '/' + relative)
      const home = envOf('USERPROFILE') || envOf('HOME')
      const dshHome = envOf('DSH_HOME') || (home === '' ? '' : home + '/.dsh')
      if (dshHome !== '') push(dshHome + '/skills/mc-art/' + relative)
      if (home !== '') push(home + '/.agents/skills/mc-art/' + relative)
      return out
    }

    // Which Python?  The extractor used to be launched as a hard-coded `python3`,
    // and that single word is what made the whole reference path (blocks, items,
    // icons, namespaces) die on a Windows machine: the interpreter there is
    // `python.exe` or the `py` launcher -- there is no `python3`.
    //
    // **唯一判据（§2.3）：真的跑一次 `-c "print(1)"`，退出码 0 且 stdout trim 后是 `1`。**
    // "命令在"、"不是 ENOENT" 都不算数，因为这台机器上两种"看着有、其实没有"都实测到了：
    //
    //   * `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe` 是 **0 字节的 Store 存根** ——
    //     起得来、退出码 9009、没有任何输出（BRIEF §1.1）。
    //   * `py` 启动器的注册表残留指向一个**已被删掉的**解释器 —— 退出码 101，
    //     `Unable to create process using '…\.tools\python312\python.exe'`。
    //
    // 候选带参数（`py -3` 拆成 bin=`py`, args=['-3']）：subprocess 那条路按 argv 起进程，
    // 把一个整串 `'py -3'` 当成可执行名交给 resolveExecutable 永远解析不出来 ——
    // 而"只有 py 能用"的 Windows 机器很常见。顺序也按 §2.3：python3 → python → py -3 → py。
    //
    // 命中后缓存；**全失败不缓存**，这样中途装上 Python 的机器下一次调用就能自愈。
    const PYTHON_CANDIDATES = [
      { bin: 'python3', args: [] },
      { bin: 'python', args: [] },
      { bin: 'py', args: ['-3'] },
      { bin: 'py', args: [] },
    ]
    let pythonLauncher = ''
    let pythonExe = ''        // 原样的可执行（subprocess 用 argv，shell 用转义过的 launcher）
    let pythonArgs = []       // 解释器自己的参数（`py -3` 的那个 -3）
    let pythonVia = null      // 'subprocess' | 'shell' —— 出错时要说清走的哪条
    let pythonWhy = null

    /**
     * 捆绑运行时（桌面端自带的那份 Python）。
     *
     * 桌面 app 把 Python 3.12 + numpy/Pillow/… 放在 `<resources>/runtime/primary-runtime/
     * dependencies/python/` 里，**但不进 PATH**（`desktopNodeEnvironment` 给子进程前置的
     * 只有 node/bin）。它给模型看的那条路是一个工具（workspace-dependencies），宿主插件
     * 拿不到 —— 所以这里按桌面端自己用的那几个位置推：环境变量、DSH_HOME 下的安装位、
     * 以及从本模块路径推出来的 resources 目录。
     */
    function bundledPythonDirs() {
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        const trimmed = value.charAt(value.length - 1) === '/' ? value.slice(0, value.length - 1) : value
        if (trimmed !== '' && out.indexOf(trimmed) < 0) out.push(trimmed)
      }
      push(envOf('DSH_DESKTOP_PRIMARY_RUNTIME_DIR'))
      // 桌面端把"运行时目录"当 argv 传给 dsh-desktop-host（它自己也是这么找 python 的）。
      if (typeof process !== 'undefined' && Array.isArray(process.argv)) {
        for (const value of process.argv) {
          if (typeof value === 'string' && /(^|[\\/])runtime[\\/]primary-runtime$/.test(value)) push(value)
        }
      }
      // 宿主进程就是 Electron（ELECTRON_RUN_AS_NODE）：<app>/resources/runtime/primary-runtime。
      if (typeof process !== 'undefined' && typeof process.execPath === 'string' && process.execPath !== '') {
        const exeDir = parentOf(process.execPath.split(BACKSLASH).join('/')) || ''
        if (exeDir !== '') push(exeDir + '/resources/runtime/primary-runtime')
      }
      const home = envOf('USERPROFILE') || envOf('HOME')
      const dshHome = envOf('DSH_HOME') || (home === '' ? '' : home + '/.dsh')
      if (dshHome !== '') {
        push(dshHome + '/dsh-runtimes/dsh-primary-runtime')
        push(dshHome + '/dsh-runtimes/dsh-primary-runtime/dependencies')
      }
      const dir = moduleDirOf()
      if (dir !== '') {
        // <resources>/app.asar/dsh/node_modules/<包>/lib → <resources>
        const pkg = parentOf(dir) || ''
        const profile = pkg === '' ? '' : (parentOf(pkg) || '')
        const appDsh = profile === '' ? '' : (parentOf(profile) || '')
        const resources = appDsh === '' ? '' : (parentOf(appDsh) || '')
        if (resources !== '') {
          push(resources + '/runtime/primary-runtime')
          push(resources + '/runtime/primary-runtime/dependencies')
        }
      }
      return out
    }

    /** 候选解释器：环境变量 → 系统 PATH（§2.3 的顺序）→ 桌面端自带的那份。 */
    function pythonCandidateList() {
      const out = []
      const seen = {}
      const push = (bin, args, guess) => {
        if (typeof bin !== 'string' || bin === '') return
        const list = Array.isArray(args) ? args : []
        const key = bin + ' ' + list.join(' ')
        if (seen[key] === true) return
        seen[key] = true
        out.push({ bin: bin, args: list, guess: guess === true })
      }
      // 显式指定的路径/命令**优先**（§2.3 的"可覆盖"）。
      push(envOf('MC_ART_PYTHON'), [], false)
      for (const candidate of PYTHON_CANDIDATES) push(candidate.bin, candidate.args, false)
      for (const dir of bundledPythonDirs()) {
        // 推出来的（guess）：出厂布局在别人的机器上不一定成立，试之前先 stat。
        push(dir + '/python/python.exe', [], true)    // Windows: dependencies/python/python.exe
        push(dir + '/python/bin/python3', [], true)   // POSIX:    dependencies/python/bin/python3
        push(dir + '/python/bin/python', [], true)
      }
      return out
    }

    /** 只给诊断看的字符串形状（`atlas.env.pythonCandidates`，协议不变）。 */
    function pythonCandidates() {
      return pythonCandidateList().map((candidate) =>
        candidate.bin + (candidate.args.length === 0 ? '' : ' ' + candidate.args.join(' ')))
    }

    /** 一件候选在报告里的写法：`py -3`。 */
    const pythonLabel = (candidate) =>
      candidate.bin + (candidate.args.length === 0 ? '' : ' ' + candidate.args.join(' '))

    async function resolvePython(workspaceRoot) {
      if (pythonLauncher !== '') return pythonLauncher
      const dialect = await currentShell(workspaceRoot)
      const tried = []
      for (const candidate of pythonCandidateList()) {
        const pathLike = isPathLike(candidate.bin)
        // 从出厂布局猜出来的捆绑运行时路径**先 stat 再试**：猜错的位置既不能命中，
        // 也不该把失败文案塞满垃圾路径（实测会推出 `<node>/resources/runtime/...`）。
        if (candidate.guess === true && pathLike) {
          const info = await statOf(candidate.bin)
          if (info === undefined || info.type !== 'file') continue
        }
        const probe = ['-c', 'print(1)']
        // 第一条：subprocess + argv。绝对路径直接用；裸名字先让它解析 PATH。
        if (pathLike || subprocessOf() !== undefined) {
          const exe = pathLike ? candidate.bin : await resolveExecutable(candidate.bin)
          if (exe !== null) {
            const done = await runProcess([exe].concat(candidate.args, probe), { maxBytes: 4096 })
            if (done !== null) {
              if (done.exitCode === 0 && String(done.text).trim() === '1') {
                pythonExe = exe
                pythonArgs = candidate.args
                pythonVia = 'subprocess'
                pythonLauncher = pythonLabel(candidate)
                return pythonLauncher
              }
              // 退出码和它自己的抱怨都要留下：9009 是 Store 存根、101 是 py 的坏注册表，
              // 光写"没找到"会让人以为这台机器上根本没有 Python。
              tried.push(pythonLabel(candidate) + '(subprocess exit=' + String(done.exitCode) +
                (String(done.err).trim() === '' ? '' : ' ' + String(done.err).trim().slice(0, 60)) + ')')
              continue
            }
          }
        }
        // 第二条：shell（老路；服务不在时 exitCode 是 null —— 把这个事实也写进去）
        const head = pathLike ? dialect.word(candidate.bin) : candidate.bin
        const words = [head].concat(candidate.args.map((arg) => dialect.word(arg)))
        const probeShell = await runShell(words.join(' ') + ' -c "print(1)"', 20000,
          policyFor(workspaceRoot), 4096)
        if (probeShell.exitCode === 0 && String(probeShell.text).trim() === '1') {
          pythonExe = candidate.bin
          pythonArgs = candidate.args
          pythonVia = 'shell'
          pythonLauncher = pythonLabel(candidate)
          return pythonLauncher
        }
        tried.push(pythonLabel(candidate) + '(shell exit=' + String(probeShell.exitCode) +
          (String(probeShell.err).trim() === '' ? '' : ' ' + String(probeShell.err).trim().slice(0, 60)) + ')')
      }
      pythonWhy = tried.join('、')
      return null
    }

    /** The launcher for a message the user reads, without probing. */
    function pythonHint() {
      return pythonLauncher === '' ? pythonLabel(PYTHON_CANDIDATES[0]) : pythonLauncher
    }

    // 参数一律当作**原始字符串数组**交进来，只在这里按方言转义——转义点只有这一个，
    // 就不会出现"某处漏了引号，Windows 上把带空格的路径拆成两个参数"这种事。
    async function runScanner(scanner, tokens, timeoutMs, workspaceRoot, maxBytes) {
      const python = await resolvePython(workspaceRoot)
      if (python === null) {
        return { error: '找不到 Python（试过 ' + String(pythonWhy) +
          '）。抽取器是 Python 写的；桌面版自带的那份在 <resources>/runtime/primary-runtime/' +
          'dependencies/python/python.exe，也可以用 MC_ART_PYTHON 指定一个。' }
      }
      // 有 subprocess 就**按 argv 起**：没有 shell、没有引号、没有方言问题
      // （Windows 的路径里有空格时，这一条比拼命令行可靠得多）。
      if (pythonVia === 'subprocess' && pythonExe !== '') {
        // `-X utf8`：Windows 上 Python 的 stdio 默认是系统区域编码（GBK），
        // 而我们按 UTF-8 解它的输出 —— 中文名字会变成 `����ʯ`（用户实测）。
        // 脚本自己也把 stdout 钉成 UTF-8（reconfigure），这里是第二层。
        //
        // `-B` = `PYTHONDONTWRITEBYTECODE=1`（subprocess 的契约里没有 env 通道，argv 里
        // 这一条两条路都管用）：抽取器 `import mcart_scan_refs`，默认会在 **随包发布的**
        // `panel/python/` 里写下 `__pycache__/*.pyc`，而每个 .pyc 里都嵌着源码字符串 ——
        // 既是路径泄漏，也是只读安装下的隐患（`entry-test` 实测留过一次）。
        const argv = [pythonExe].concat(pythonArgs, ['-B', '-X', 'utf8', scanner], tokens === undefined ? [] : tokens)
        const done = await runProcess(argv, { cwd: workspaceRoot, maxBytes: maxBytes === undefined ? 8 * 1024 * 1024 : maxBytes })
        if (done !== null) {
          if (done.exitCode !== 0) {
            const detail = beforeStderr(done.err === undefined || done.err === null ? '' : done.err)
            return { error: '扫描脚本退出码 ' + done.exitCode + (detail === '' ? '，没有任何错误输出' : '：' + detail) }
          }
          try {
            return JSON.parse(beforeStderr(done.text))
          } catch (error) {
            return { error: '扫描脚本的输出不是 JSON：' + String(done.text).slice(0, 200) }
          }
        }
      }
      const dialect = await currentShell(workspaceRoot)
      const argument = (tokens === undefined ? [] : tokens).map((token) => dialect.word(token)).join(' ')
      const result = await runShell(python + ' -B -X utf8 ' + dialect.word(scanner) +
        (argument === '' ? '' : ' ' + argument), timeoutMs, policyFor(workspaceRoot), maxBytes)
      if (result.exitCode !== 0) {
        const detail = beforeStderr(result.err === undefined || result.err === null ? '' : result.err)
        return { error: '扫描脚本退出码 ' + result.exitCode + (detail === '' ? '，没有任何错误输出' : '：' + detail) }
      }
      try {
        return JSON.parse(beforeStderr(result.text))
      } catch (error) {
        return { error: '扫描脚本的输出不是 JSON：' + String(result.text).slice(0, 200) }
      }
    }

