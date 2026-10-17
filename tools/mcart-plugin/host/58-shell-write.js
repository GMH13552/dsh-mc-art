    // 这个 shell 服务的**执行方法叫什么**，两代不一样：
    //   0.1.x（本仓库开发用的那套）：`resolve(request)` + `run(spec)`（交互式还有 `start(spec)`）
    //   0.2.0-rc.x（Windows 桌面端）：`resolve(request)` + `execute(spec)`，**没有 run/start**
    // 实测报错就是 `shellOf(...).run is not a function`。形状子集是兼容的（都回
    // {exitCode, stdout:{text}, stderr:{text}}），所以这里只做方法名探测。
    async function shellExec(spec) {
      const service = shellOf()
      if (service === undefined) return { exitCode: null, text: '', err: 'no shell service' }
      if (typeof service.run === 'function') return await service.run(spec)
      if (typeof service.execute === 'function') return await service.execute(spec)
      return { exitCode: null, text: '', err: '这个 shell 服务既没有 run() 也没有 execute()：' +
        Object.keys(service).join(',') }
    }

    /** 把两代的结果形状收成同一种（stdout/stderr 可能是 {text} 也可能是字符串）。 */
    function shellText(value) {
      if (value === undefined || value === null) return ''
      if (typeof value === 'string') return value
      return value.text === undefined ? String(value) : String(value.text)
    }

    async function runShell(command, timeoutMs, sandboxPolicy, maxBytes) {
      if (shellOf() === undefined) return { exitCode: null, text: '', err: 'no shell service' }
      // The cap is per call, not a constant: a namespace listing is genuinely
      // ~190 KB (AoA3 alone is 1403 blocks), and the 64 KB default truncated it
      // into invalid JSON.  A silently cut payload is worse than a slow one.
      const request = { command: command, timeoutMs: timeoutMs === undefined ? 20000 : timeoutMs,
        stdoutMaxBytes: maxBytes === undefined ? 64 * 1024 : maxBytes }
      if (sandboxPolicy !== undefined) request.sandboxPolicy = sandboxPolicy
      const spec = shellOf().resolve(request)
      const result = await shellExec(spec)
      return { exitCode: result.exitCode === undefined ? null : result.exitCode,
        text: shellText(result.stdout), err: shellText(result.stderr) }
    }

    async function available(tool) {
      const dialect = await currentShell('')
      const result = await runShell(dialect.available(tool), 10000)
      return result.exitCode === 0 && String(result.text).trim().length > 0
    }

    // ── 这个 shell 说的是哪种方言 ────────────────────────────────────────────
    // DSH 按平台换 shell：POSIX 上是 `bash -c`，Windows 上是
    // `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`——dsh-base 的
    // cordis.patch.yml 里 bash 那几行在 win32 上 disabled、pwsh 那几行启用
    // （tool-bash/tool-pwsh 同理）。所以 `$(printf … | base64 -d)`、`rm -f`、
    // `mv -f`、`command -v` 在 Windows 上一个都不是命令。
    //
    // 这里是"谁在给我跑命令"的唯一真相：探一次，然后所有命令都按方言拼。
    // 探法：`$($PSVersionTable.PSVersion.Major)` 在 bash 里是个跑不通的命令替换
    // （展开成空），在 PowerShell 里展开成 5 或 7。
    const PS_QUOTE = (value) => "'" + String(value).split("'").join("''") + "'"
    const SHELLS = {
      posix: {
        name: 'posix',
        word: (value) => shellDecoded(value),
        available: (tool) => 'command -v ' + tool,
        remove: (path) => 'rm -f ' + shellDecoded(path),
        makeDir: (path) => 'mkdir -p ' + shellDecoded(path),
        move: (from, to) => 'mv -f ' + shellDecoded(from) + ' ' + shellDecoded(to),
        // 从暂存文件解开（命令行里只有路径）；writeInline 只在没有 fs 服务时兜底。
        decodeFile: (source, target) =>
          'base64 -d < ' + shellDecoded(source) + ' > ' + shellDecoded(target),
        writeInline: (target, base64) =>
          'printf %s ' + quoteRaw(base64) + ' | base64 -d > ' + shellDecoded(target),
      },
      pwsh: {
        name: 'pwsh',
        word: (value) => PS_QUOTE(value),
        available: (tool) => '(Get-Command ' + PS_QUOTE(tool) + ' -ErrorAction SilentlyContinue) -ne $null',
        remove: (path) => 'Remove-Item -LiteralPath ' + PS_QUOTE(path) + ' -Force -ErrorAction SilentlyContinue',
        // -Force 让"已存在"也返回成功（幂等）；[IO.Directory] 比 New-Item 少一层 cmdlet 开销。
        makeDir: (path) => '[IO.Directory]::CreateDirectory(' + PS_QUOTE(path) + ') | Out-Null',
        move: (from, to) => 'Move-Item -LiteralPath ' + PS_QUOTE(from) +
          ' -Destination ' + PS_QUOTE(to) + ' -Force',
        // .NET 一次解码；暂存文件的内容由 fs 服务写（见 writeDecodedFile），
        // 所以命令行里同样只有路径——Windows 的 32767 字符上限碰不到。
        decodeFile: (source, target) => '[IO.File]::WriteAllBytes(' + PS_QUOTE(target) +
          ', [Convert]::FromBase64String([IO.File]::ReadAllText(' + PS_QUOTE(source) + ')))',
        writeInline: (target, base64) => '[IO.File]::WriteAllBytes(' + PS_QUOTE(target) +
          ', [Convert]::FromBase64String(' + PS_QUOTE(base64) + '))',
      },
    }
    let shellDialect = null
    /** 诊断用：平台与探针各说了什么（`atlas.env` 里回读）。 */
    let shellProbeInfo = null
    async function currentShell(workspaceRoot) {
      if (shellDialect !== null) return SHELLS[shellDialect]
      // **先看平台，再看探针**。平台是事实，探针是猜测 —— 而"探针失败就当成 POSIX"
      // 曾经在 Windows 上造成过一句彻头彻尾错的提示：所有命令都按 bash 拼，
      // `command -v powershell.exe` 自然找不到，于是面板说
      // 「这个环境既没有 powershell.exe（Windows/WSL）也没有 zenity/kdialog/yad」。
      // 用户当场就问"为啥啊" —— 因为 Windows 上 powershell.exe 怎么可能没有。
      const platform = platformOf()
      if (platform === 'win32') {
        shellProbeInfo = { platform: platform, dialect: 'pwsh', why: '按平台定的（没跑探针）' }
        shellDialect = 'pwsh'
        return SHELLS.pwsh
      }
      if (platform === 'linux' || platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd' || platform === 'sunos' || platform === 'aix') {
        shellProbeInfo = { platform: platform, dialect: 'posix', why: '按平台定的（没跑探针）' }
        shellDialect = 'posix'
        return SHELLS.posix
      }
      // 平台问不到（只在动态插件那种没有 `process` 的环境里）才让探针说话。
      const probe = await runShell('echo "mcart-shell:$($PSVersionTable.PSVersion.Major)"', 20000,
        policyFor(workspaceRoot), 4096)
      shellProbeInfo = { platform: platform, exitCode: probe.exitCode,
        text: String(probe.text).slice(0, 80), err: String(probe.err).slice(0, 80) }
      // 探不通就不下结论、也不缓存：服务没起来的时候不该把这个会话钉在错的方言上。
      if (probe.exitCode !== 0) return SHELLS.posix
      shellDialect = /^mcart-shell:\d+/.test(String(probe.text).trim()) ? 'pwsh' : 'posix'
      return SHELLS[shellDialect]
    }

    /**
     * 这台机器上的 Windows PowerShell 在哪。
     *
     * 以前只用 `command -v powershell.exe`（`Get-Command`）问 shell —— 那等于把
     * "能不能弹目录对话框"押在"宿主进程的 PATH 恰好和用户终端一样"上。现在先看
     * **绝对路径**（SystemRoot 下那个是 Windows 自带的固定位置），再看 PATH，最后 `pwsh`。
     */
    async function windowsPowerShell() {
      const root = (envOf('SystemRoot') || 'C:/Windows').split(BACKSLASH).join('/')
      const absolute = [
        root + '/System32/WindowsPowerShell/v1.0/powershell.exe',
        'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ]
      for (const candidate of absolute) {
        const info = await statOf(candidate)
        if (info !== undefined && info.type === 'file') return candidate
      }
      for (const name of ['powershell.exe', 'pwsh']) {
        if (shellOf() !== undefined && await available(name)) return name
      }
      return null
    }

    /**
     * 把 base64 解成一个文件——**分两步，命令行里永远只有路径**。
     *
     * 为什么不直接把 base64 拼进命令：Windows 的命令行总长上限约 32767 字符，
     * 一张 128×128 的贴图 base64 就有几十 KB，塞进 `pwsh -Command` 会失败，
     * 而且失败得含糊（"命令行太长"）。而且图片内容本来就不该经过一个会被日志和
     * 引号规则来回揉的通道。
     *
     * 所以：base64 当**文本**用 fs 服务写进一个暂存文件（同一条 sandbox 策略，
     * 且 fsOf().writeText 对长度没意见），shell 只负责"把这个文件解成字节"。
     * 没有 fs 服务时才退回把 payload 拼进命令的老办法（那时数据也小）。
     */
    async function writeDecodedFile(target, base64, workspaceRoot, timeoutMs) {
      // 第一条路：fs 写暂存文本 + shell 解码（都带同一条 sandbox 策略）。
      if (shellOf() !== undefined) {
        const dialect = await currentShell(workspaceRoot)
        const policy = policyFor(workspaceRoot)
        const staging = target + '.mcart-b64'
        const staged = await writeTextFile(staging, base64, workspaceRoot)
        if (staged.ok !== true) {
          return { ok: false, exitCode: null, err: String(staged.detail), step: 1, steps: 2 }
        }
        const done = await runShell(dialect.decodeFile(staging, target), timeoutMs, policy)
        const cleanup = await runShell(dialect.remove(staging), 15000, policy)
        if (done.exitCode === 0) {
          return { ok: true, steps: 2, dialect: dialect.name, stagingRemoved: cleanup.exitCode === 0 }
        }
        // shell 在但这一步没过：只有本地垫片还能试，否则就是它的报错。
        const local = localOf()
        if (local === null) {
          return { ok: false, exitCode: done.exitCode, err: done.err, step: 2, steps: 2 }
        }
        try {
          await local.writeBase64(target, base64)
          return { ok: true, steps: 1, dialect: dialect.name, via: 'node:fs',
            shellSaid: 'exit=' + String(done.exitCode) }
        } catch (error) {
          return { ok: false, exitCode: done.exitCode,
            err: beforeStderr(String(done.err)) + ' | node:fs: ' + messageOf(error), step: 2, steps: 2 }
        }
      }
      // 没有 shell：base64 直接交给本地垫片写字节，一步到位、没有暂存文件。
      const local = localOf()
      if (local === null) {
        return { ok: false, exitCode: null, step: 0, steps: 1,
          err: '宿主既没有 shell 服务，也没有本地文件系统垫片' }
      }
      try {
        await local.writeBase64(target, base64)
        return { ok: true, steps: 1, via: 'node:fs' }
      } catch (error) {
        return { ok: false, exitCode: null, step: 0, steps: 1, err: messageOf(error) }
      }
    }

    /**
     * 建目录（幂等）——**四条路，逐条报自己的失败原因**。
     *
     * 顺序是有讲究的：
     *   1. `directoryPickerController.createDirectory(parent, name)`：harness 自己的
     *      "新建文件夹"API（目录选择器用的就是它），非递归、已存在会抛 EEXIST，
     *      所以先 stat 过才调；
     *   2. `shell`：方言拼出来的真 mkdir（0.1.x / 0.2.0-rc 都能用）；
     *   3. `fs` 服务：写一个占位文件进去——`dsh-fs-local` 的 writeFileAtomic 第一件事
     *      就是 `mkdir(dirname, {recursive:true})`（两代都是），所以父目录会被建出来。
     *      代价是空目录里多一个 `.gitkeep`（git 本来也追踪不了空目录，不是纯负担）；
     *   4. `node:fs` 垫片：最后的退路，结果里写 via=node:fs。
     *
     * 返回 { ok, via, placeholder, detail }，绝不返回裸布尔——调用方要能把
     * "到底哪条路试过、各说什么"原样端给用户。
     */
    async function ensureDir(path, workspaceRoot, depth) {
      if (await isDirectoryOf(path)) return { ok: true, via: 'existing' }
      const tried = []
      const level = depth === undefined ? 0 : depth
      const picker = ctx.get('directoryPickerController')
      if (picker !== undefined && typeof picker.createDirectory === 'function') {
        const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
        if (cut > 0) {
          const parent = path.slice(0, cut)
          const name = path.slice(cut + 1)
          try {
            await picker.createDirectory(parent, name)
            return { ok: true, via: 'directoryPickerController' }
          } catch (error) {
            // 这个 API 是**非递归**的：父目录不在就 ENOENT（'textures/block' 这种
            // 中间层不在目录清单里时就会撞上）。先把父目录建出来，再试一次；
            // 深度上限只是防呆，正常调用不会接近它。
            if (level < 8) {
              const up = await ensureDir(parent, workspaceRoot, level + 1)
              if (up.ok === true) {
                try {
                  await picker.createDirectory(parent, name)
                  return { ok: true, via: 'directoryPickerController' }
                } catch (again) { tried.push('directoryPickerController: ' + messageOf(again)) }
              } else {
                tried.push('directoryPickerController: ' + messageOf(error) +
                  '；父目录也建不出来：' + String(up.detail))
              }
            } else tried.push('directoryPickerController: ' + messageOf(error))
          }
        } else tried.push('directoryPickerController: 路径里没有父目录')
      } else tried.push('directoryPickerController: 宿主没有这个服务')
      if (shellOf() !== undefined) {
        const done = await shellFileOp(workspaceRoot, (dialect) => dialect.makeDir(path), 20000)
        if (done.ok === true) return { ok: true, via: 'shell' }
        const detail = beforeStderr(done.err === undefined || done.err === null ? '' : done.err)
        tried.push('shell: 退出码 ' + String(done.exitCode) + (detail === '' ? '，没有错误输出' : '，' + detail))
      } else tried.push('shell: 宿主没有这个服务')
      if (fsOf() !== undefined) {
        try {
          const target = await fsOf().resolve(path + '/.gitkeep')
          await fsOf().writeText(target, '', undefined, undefined, policyFor(workspaceRoot))
          return { ok: true, via: 'fs', placeholder: true }
        } catch (error) { tried.push('fs: ' + messageOf(error)) }
      } else tried.push('fs: 宿主没有这个服务')
      const local = localOf()
      if (local !== null) {
        try {
          await local.mkdirp(path)
          return { ok: true, via: 'node:fs' }
        } catch (error) { tried.push('node:fs: ' + messageOf(error)) }
      } else tried.push('node:fs: 这个运行时里没有文件系统垫片')
      return { ok: false, detail: tried.join('；') }
    }

    /** 一条收尾命令（删/移），按方言拼；shell 不行时落到本地垫片。 */
    async function shellFileOp(workspaceRoot, build, timeoutMs) {
      if (shellOf() === undefined) return { ok: false, exitCode: null, err: 'no shell service' }
      const dialect = await currentShell(workspaceRoot)
      const done = await runShell(build(dialect), timeoutMs, policyFor(workspaceRoot))
      return { ok: done.exitCode === 0, exitCode: done.exitCode, err: done.err }
    }

    async function removeFile(path, workspaceRoot) {
      const done = await shellFileOp(workspaceRoot, (dialect) => dialect.remove(path), 15000)
      if (done.ok === true) return { ok: true, via: 'shell' }
      const local = localOf()
      if (local === null) return { ok: false, detail: String(done.err) }
      try {
        await local.remove(path)
        return { ok: true, via: 'node:fs' }
      } catch (error) { return { ok: false, detail: messageOf(error) } }
    }

    async function moveFile(from, to, workspaceRoot) {
      const done = await shellFileOp(workspaceRoot, (dialect) => dialect.move(from, to), 20000)
      if (done.ok === true) return { ok: true, via: 'shell' }
      const local = localOf()
      if (local === null) return { ok: false, exitCode: done.exitCode, detail: String(done.err) }
      try {
        await local.move(from, to)
        return { ok: true, via: 'node:fs' }
      } catch (error) {
        return { ok: false, exitCode: done.exitCode, detail: messageOf(error) }
      }
    }

    async function runDialog(command, sandboxPolicy, workspaceRoot) {
      if (shellOf() === undefined) return ''
      const request = { command: command, stdoutMaxBytes: 64 * 1024 }
      if (sandboxPolicy !== undefined) request.sandboxPolicy = sandboxPolicy
      const spec = shellOf().resolve(request)
      // 交互式（要边跑边读输出，比如弹系统目录对话框）只有 0.1.x 那代有 `start`；
      // 0.2.0-rc 只有 `execute`，那就等它跑完再收输出 —— 目录对话框本来也是"选完才返回"。
      if (typeof shellOf().start === 'function') {
        const process = await shellOf().start(spec)
        await process.done
        return String(process.readOutput().delta)
      }
      const done = await shellExec(spec)
      return shellText(done.stdout)
    }

    async function convertPath(flag, value) {
      const trimmed = String(value === undefined || value === null ? '' : value).trim()
      if (trimmed === '') return null
      if (hasWslpath === null) hasWslpath = await available('wslpath')
      if (hasWslpath !== true) return null
      const result = await runShell('wslpath ' + flag + ' ' + shellDecoded(trimmed), 15000)
      if (result.exitCode !== 0) return null
      const converted = beforeStderr(result.text)
      return converted === '' ? null : converted
    }

    // The fs service is the abstraction for writing, and it takes the sandbox
    // policy PER CALL.  Omitting it left the backend its own default, and the
    // write was fenced off -- which showed up as a bare "写入失败" with no why.
    // Now: fs first (with an explicit policy), shell second (also explicit), and
    // both failures are reported verbatim -- plus the local shim third, because
    // "one of these two services is missing" must not mean "cannot write".
    async function writeTextFile(path, text, workspaceRoot) {
      const policy = policyFor(workspaceRoot)
      let fsDetail = null
      if (fsOf() !== undefined) {
        try {
          const target = await fsOf().resolve(path)
          await fsOf().writeText(target, text, undefined, undefined, policy)
          return { ok: true, via: 'fs' }
        } catch (error) {
          fsDetail = messageOf(error)
        }
      } else {
        fsDetail = 'no fs service'
      }
      let shellDetail = 'no shell service'
      if (shellOf() !== undefined) {
        const dialect = await currentShell(workspaceRoot)
        const result = await runShell(dialect.writeInline(path, base64OfString(text)), 20000, policy)
        if (result.exitCode === 0) return { ok: true, via: 'shell' }
        const detail = beforeStderr(result.err === undefined || result.err === null ? '' : result.err)
        shellDetail = 'exit=' + result.exitCode + (detail === '' ? '' : ' err=' + detail)
      }
      const local = localOf()
      if (local !== null) {
        try {
          await local.writeText(path, text)
          return { ok: true, via: 'node:fs' }
        } catch (error) {
          return { ok: false, detail: 'fs: ' + fsDetail + ' | shell: ' + shellDetail +
            ' | node:fs: ' + messageOf(error) }
        }
      }
      return { ok: false, detail: 'fs: ' + fsDetail + ' | shell: ' + shellDetail +
        ' | node:fs: 这个运行时里没有文件系统垫片' }
    }

