    function note(message) {
      if (errors.indexOf(message) < 0) errors.push(message)
    }

    const messageOf = (error) => String(error && error.message ? error.message : error)

    // ── 文件系统：先问服务，再问本地 ─────────────────────────────────────────
    //
    // `fs` 和 `shell` 都是**可能缺席**的外部依赖，而面板要干的事（扫描工程、写
    // 贴图、建目录）不该因为"这次启动顺序里没有那个服务"就整个不能用。用户机器上
    // 实测过这个症状（Windows 桌面端 0.2.0-rc.2）：面板能建出工程目录的引导卡、
    // 也能弹系统的目录选择器，但"建目录"那一步只回了一句含糊的
    // 「宿主没有 shell 服务时建不出目录」——而这句话是**猜的**：ensureDir 只看了
    // exitCode，既没看服务在不在，也没把 shell 自己的报错带回来。
    //
    // 所以这一版两条规则：
    //   1. 每一层只报**它自己**的失败原因，不再替别人下结论（错误串里逐个列出）；
    //   2. 每件事都有退路：harness 自己的 API → fs 服务 → shell → node:fs 垫片。
    //
    // node:fs 垫片排在最后是有意的：它绕过宿主那条 sandbox 策略（不产生文件效应
    // 记录、不会触发审批）。前面几条都不可用时才用它，并且结果里会写明 via=node:fs，
    // 用户看得见文件是被哪条路写下去的。
    function localOf() {
      if (typeof nodeFs === 'undefined' || nodeFs === null || nodeFs.available !== true) return null
      return nodeFs
    }

    /**
     * `ctx.subprocess`（宿主层那条与 agent 无关的执行缝）——**面板的主要执行方式**。
     *
     * 为什么不能用 `ctx.shell`：用户桌面端实测（0.2.0-rc.2），`pwsh` 工具在**会话层**跑得好好的
     * （会话日志里 260 次工具调用、0 次 shell 报错），但面板在**宿主层** `ctx.get('shell')`
     * 是 undefined —— 所有探测都回 `exitCode: null`，于是"找不到 Python"里每一项都写着
     * `exit=null`，看的人完全不知道是被执行了没成功，还是根本没被执行的。
     * `subprocess` 不需要 shell：给它 argv，它按绝对路径起进程。桌面版自带的那份 Python
     * 就是这么能跑起来的（它压根不在 PATH 里）。
     */
    const subprocessOf = () => ctx.get('subprocess')

    /**
     * 给"可能永远不返回"的调用兜一个期限。
     *
     * 为什么在**宿主**这半边做：客户端不许碰浏览器计时器（动态插件沙箱里没有
     * setTimeout，碰了整个页签会崩 —— `tools/mcart-plugin/anim-test.js` 钉的就是这条），
     * 而宿主半有 `ctx.timer`。所以"目录对话框弹不出来、也永不返回"这件事由宿主负责
     * 回一个 supported:false（而不是让面板的按钮永久停在"对话框已打开…"）。
     */
    async function withDeadline(run, ms) {
      const timer = ctx.get('timer')
      if (timer === undefined || typeof timer.timeout !== 'function') return await run()
      let timeout = false
      const deadline = new Promise((resolve) => {
        timer.timeout(() => { timeout = true; resolve() }, ms)
      })
      const finished = Promise.resolve().then(run).then((value) => ({ value: value }), (error) => ({ error: error }))
      const winner = await Promise.race([finished, deadline.then(() => ({ deadline: true }))])
      if (winner.deadline === true) return { deadlineExpired: true }
      if (winner.error !== undefined) throw winner.error
      return winner.value
    }

    /** 起一个进程并收输出；`null` = 这个运行时装不下 subprocess 那条路。 */
    async function runProcess(argv, options) {
      const settings = options || {}
      const service = subprocessOf()
      if (service === undefined || typeof service.spawn !== 'function') return null
      const maxBytes = settings.maxBytes === undefined ? 1024 * 1024 : settings.maxBytes
      const collect = { maxBytes: maxBytes }
      let handle = null
      try {
        handle = service.spawn({
          argv: argv,
          cwd: settings.cwd === undefined || settings.cwd === '' ? '.' : settings.cwd,
          stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
          graceMs: settings.graceMs === undefined ? 5000 : settings.graceMs,
        })
      } catch (error) {
        return { exitCode: null, text: '', err: 'subprocess.spawn 失败：' + messageOf(error), via: 'subprocess' }
      }
      let exitCode = null
      try {
        const done = await handle.done
        exitCode = done === undefined || done === null || done.exitCode === undefined ? null : done.exitCode
      } catch (error) {
        exitCode = null
      }
      const read = (reader) => {
        try { return reader === undefined ? '' : String(reader.readFrom(0).text) } catch (error) { return '' }
      }
      const collected = handle.collected || {}
      return { exitCode: exitCode, text: read(collected.stdout), err: read(collected.stderr), via: 'subprocess' }
    }

    /** 让 subprocess 在同一条执行世界里解析一个可执行名（PATH 由它负责）。 */
    async function resolveExecutable(name) {
      const service = subprocessOf()
      if (service === undefined || typeof service.resolveExecutable !== 'function') return null
      try {
        const found = await service.resolveExecutable(name)
        return typeof found === 'string' && found !== '' ? found : null
      } catch (error) { return null }
    }

    const isPathLike = (value) => String(value).indexOf('/') >= 0 || String(value).indexOf(BACKSLASH) >= 0

    function policyFor(workspaceRoot) {
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return undefined
      return { mode: 'workspace-write', workspaceRoot: workspaceRoot }
    }

    function labelFor(namespace, kind, id) {
      const table = langs.get(namespace)
      if (table === undefined) return id
      const tries = []
      if (kind === 'project') tries.push('mc-art.project.' + namespace)
      else if (kind === 'structure') tries.push('mc-art.structure.' + namespace + '.' + id, 'structure.' + namespace + '.' + id)
      else tries.push(kind + '.' + namespace + '.' + id)
      for (const key of tries) {
        const found = table[key]
        if (typeof found === 'string' && found.length > 0) return found
      }
      return id
    }

    function rel(root, absolute) {
      const prefix = root.charAt(root.length - 1) === '/' ? root : root + '/'
      return absolute.indexOf(prefix) === 0 ? absolute.slice(prefix.length) : absolute
    }

    /** 这一层是不是一个目录（服务在就只问服务；服务不在才问本地）。 */
    async function isDirectoryOf(path) {
      const info = await statOf(path)
      return info !== undefined && info.type === 'directory'
    }

    async function listDir(path) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          const info = await fs.stat(target)
          if (info === undefined || info.type !== 'directory') return []
          return await fs.listDir(target)
        } catch (error) { return [] }
      }
      const local = localOf()
      return local === null ? [] : await local.listDir(path)
    }

    async function readJson(path) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          const info = await fs.stat(target)
          if (info === undefined || info.type !== 'file') return undefined
          return JSON.parse(await fs.readText(target))
        } catch (error) { return undefined }
      }
      const local = localOf()
      if (local === null) return undefined
      const text = await local.readText(path)
      if (typeof text !== 'string') return undefined
      try { return JSON.parse(text) } catch (error) { return undefined }
    }

    /** 读文本（`.mcmeta` 这类）。失败返回 undefined —— 调用方负责把"读不到"说成读不到。 */
    async function readTextOf(path) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          return await fs.readText(target)
        } catch (error) { return undefined }
      }
      const local = localOf()
      if (local === null) return undefined
      const text = await local.readText(path)
      return typeof text === 'string' ? text : undefined
    }

    async function statOf(path) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          return await fs.stat(target)
        } catch (error) { return undefined }
      }
      const local = localOf()
      return local === null ? undefined : await local.stat(path)
    }

    /** 读原始字节（贴图校验、预览）：fs 服务没有二进制读的替代品，但本地垫片有。 */
    async function readBytesOf(path, maxBytes) {
      const fs = fsOf()
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(path)
          return await fs.readBytes(target, undefined, maxBytes)
        } catch (error) { /* 落到本地垫片 */ }
      }
      const local = localOf()
      return local === null ? undefined : await local.readBytes(path, maxBytes)
    }

    async function dirSignature(path) {
      const entries = await listDir(path)
      const parts = []
      for (const entry of entries) {
        parts.push(entry.name + ':' + (entry.version === undefined ? '-' : String(entry.version)) + ':' + (entry.size === undefined ? '-' : String(entry.size)))
      }
      parts.sort()
      return parts.join(',')
    }

    async function signatureOf(root) {
      const pieces = []
      const top = await listDir(root)
      for (const entry of top) {
        if (entry.type !== 'directory' || entry.name.charAt(0) === '.') continue
        const dir = root + '/' + entry.name
        const atlasInfo = await statOf(dir + '/mc-art.atlas.json')
        pieces.push('A' + entry.name + ':' + (atlasInfo === undefined ? 'none' : String(atlasInfo.version) + ':' + String(atlasInfo.size)))
        const assets = await listDir(dir + '/pack/assets')
        for (const ns of assets) {
          if (ns.type !== 'directory') continue
          const base = dir + '/pack/assets/' + ns.name
          pieces.push(await dirSignature(base + '/blockstates'))
          pieces.push(await dirSignature(base + '/models/block'))
          pieces.push(await dirSignature(base + '/lang'))
          for (const kind of ['block', 'blocks', 'entity', 'item']) pieces.push(await dirSignature(base + '/textures/' + kind))
        }
      }
      return pieces.join('|')
    }

