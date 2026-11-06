    // ── 「启动游戏」的三个宿主方法（注册在 installHost 里，和别的 handler 同一张表）──
    //
    // 方法名按任务书：`atlas.launchTargets` / `atlas.launch` / `atlas.launchStatus` /
    // `atlas.launchStop`。参数沿用面板其余方法的体例：`root` + `project` 可选，用来
    // 定位"项目目录"（日志就写在项目目录里）；`launch` 自己的参数见下面。
    ctx.effect(() => harness.handle('atlas.launchTargets', async (args) => {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      try {
        const projectDir = await launchProjectDir(root, projectId)
        const settingsDirectory = await launchSettingsDirectory(projectDir)
        const near = projectDir === '' ? root : projectDir
        const explicit = typeof request.gameRoot === 'string' ? request.gameRoot : ''
        const gameRoots = await launchGameRootsNear(near, settingsDirectory, explicit)
        const versions = []
        for (const gameRoot of gameRoots) {
          const entries = await listDir(gameRoot + '/versions')
          for (const entry of entries.slice(0, 40)) {
            if (entry.type !== 'directory') continue
            const jsonPath = gameRoot + '/versions/' + entry.name + '/' + entry.name + '.json'
            const json = await readJson(jsonPath)
            const jarInfo = await statOf(gameRoot + '/versions/' + entry.name + '/' + entry.name + '.jar')
            const record = {
              id: entry.name,
              hasJar: jarInfo !== undefined && jarInfo.type === 'file',
              jsonPath: jsonPath,
              mainClass: '',
              inheritedFrom: '',
              javaMajor: 0,
              root: gameRoot,
            }
            if (json !== null && json !== undefined && typeof json === 'object') {
              if (typeof json.mainClass === 'string') record.mainClass = json.mainClass
              if (typeof json.inheritsFrom === 'string') record.inheritedFrom = json.inheritsFrom
              const version = json.javaVersion
              if (version !== null && version !== undefined && typeof version === 'object'
                && typeof version.majorVersion === 'number') record.javaMajor = version.majorVersion
              if (typeof json.type === 'string') record.type = json.type
              if (typeof json.assets === 'string') record.assets = json.assets
              // `inheritsFrom` 的版本自己可能没有 javaVersion / assets：按合并后的结果补。
              if (record.javaMajor === 0 || record.assets === undefined) {
                const merged = await launchResolveVersion(gameRoot, entry.name, 0, {})
                if (merged.error === undefined) {
                  if (record.javaMajor === 0 && merged.javaMajor > 0) record.javaMajor = merged.javaMajor
                  if (record.assets === undefined && merged.assets !== '') record.assets = merged.assets
                  if (record.mainClass === '' && merged.mainClass !== '') record.mainClass = merged.mainClass
                }
              }
            }
            versions.push(record)
          }
        }
        // JDK 探测要真跑进程，放在最后；失败候选也回给界面（诊断用，不静默吞）。
        const probed = await launchProbeJavas(gameRoots)
        return {
          gameRoots: gameRoots,
          versions: versions,
          javas: probed.javas,
          javaRejected: probed.rejected,
          settingsDirectory: settingsDirectory,
          platform: platformOf() || null,
          platformArch: launchOsArch() || null,
          error: null,
        }
      } catch (error) {
        return { gameRoots: [], versions: [], javas: [], javaRejected: [], settingsDirectory: '',
          platform: platformOf() || null, platformArch: launchOsArch() || null,
          error: '探测启动目标失败：' + messageOf(error) }
      }
    }))

    /** `atlas.launch` 的本体（外层那一圈只负责把意外异常翻成人话）。 */
    async function launchRequest(args) {
      const request = args || {}
      const root = typeof request.root === 'string' ? request.root : ''
      const projectId = typeof request.project === 'string' ? request.project : ''
      const gameRoot = launchTrimPath(typeof request.gameRoot === 'string' ? request.gameRoot : '')
      const versionId = typeof request.versionId === 'string' ? request.versionId : ''
      const javaPath = launchTrimPath(typeof request.javaPath === 'string' ? request.javaPath : '')
      const dryRun = request.dryRun === true
      if (gameRoot === '') return { error: '没有给定游戏根（.minecraft 目录）' }
      if (versionId === '') return { error: '没有选择要启动的版本' }

      // 真启动前先确认 JDK **真的能跑**（-version 退出码 + 版本号）；dryRun 只拼参数，
      // 为了不让门禁的假 JDK 也必须会答 -version，这里跳过探测。
      let java = null
      if (dryRun !== true) {
        if (javaPath === '') {
          return { error: '没有选 JDK。1.18.2 需要 Java 17；下拉里带「17」的那一项是游戏自带的那个。' }
        }
        const probe = await launchProbeJava({ path: javaPath, source: 'selected' })
        if (probe.ok !== true) {
          return { error: '这个 JDK 跑不起来：' + javaPath + '（' + String(probe.why) + '）。'
            + '换下拉里的另一个，或把 JAVA_HOME 指到能用的 JDK。' }
        }
        java = probe
      }
      const javaExec = java === null ? (javaPath === '' ? 'java' : javaPath) : java.path

      const build = await launchBuild({
        gameRoot: gameRoot, versionId: versionId, gameDir: request.gameDir,
        memoryMb: request.memoryMb, extraArgs: request.extraArgs, dryRun: dryRun,
      })
      if (build.error !== undefined) {
        return { error: build.error, missing: Array.isArray(build.missing) ? build.missing : [] }
      }
      if (build.missing.length > 0) {
        return {
          error: '游戏文件不全：缺 ' + build.missing.length + ' 个 jar，启动必然失败。'
            + '缺的前几个：' + build.missing.slice(0, 3).join('、'),
          missing: build.missing,
          args: [javaExec].concat(build.args),
        }
      }
      const command = [javaExec].concat(build.args)
      const leftover = launchLeftoverPlaceholders(command)

      if (dryRun === true) {
        return {
          dryRun: true,
          args: command,
          mainClass: build.mainClass,
          classpath: build.classpath,
          nativesDir: build.nativesDir,
          nativesList: build.natives,
          gameDir: build.gameDir,
          versionId: build.versionId,
          chain: build.chain,
          memoryMb: build.memoryMb,
          javaMajor: build.javaMajor,
          assetIndex: build.assetIndex,
          leftover: leftover,
          missing: build.missing,
          logFile: null,
        }
      }

      if (launchRun !== null && launchRun.running === true) {
        return { error: '已经有一个游戏在跑了（pid ' + String(launchRun.pid === null ? '?' : launchRun.pid)
          + '）。先点「停止」，或者等它退出。' }
      }

      const projectDir = await launchProjectDir(root, projectId)
      // 日志只写项目目录（没有项目信息时退到游戏目录本身）；不写会话/日志系统。
      const logDir = projectDir === '' ? build.gameDir : projectDir
      // gameDir 不存在就建出来（子进程的 cwd 指过去，不建 spawn 直接失败）。
      const madeGameDir = await ensureDir(build.gameDir, build.gameRoot)
      if (madeGameDir.ok !== true) {
        return { error: '建不出游戏目录 ' + build.gameDir + '：' + (madeGameDir.detail === undefined ? '宿主没有给出原因' : String(madeGameDir.detail)) }
      }
      const started = await launchStart(Object.assign({}, build, { command: command }), logDir)
      if (started.error !== undefined) return started
      const warnings = []
      if (java !== null && build.javaMajor > 0 && java.major !== build.javaMajor) {
        warnings.push('这个版本 JSON 要 Java ' + String(build.javaMajor) + '，现在选的是 Java '
          + String(java.major) + ' —— 可能起不来')
      }
      if (leftover.length > 0) warnings.push('参数里有没替换掉的占位符：' + leftover.join('、'))
      if (Array.isArray(build.nativesFailures) && build.nativesFailures.length > 0) {
        warnings.push('有 ' + String(build.nativesFailures.length) + ' 个 natives 包没解开（' + build.nativesFailures[0] + '）')
      }
      return {
        pid: started.pid,
        startedAt: started.startedAt,
        logFile: started.logFile,
        versionId: started.versionId,
        mainClass: started.mainClass,
        nativesDir: started.nativesDir,
        memoryMb: started.memoryMb,
        argsCount: started.argsCount,
        javaMajor: started.javaMajor,
        warning: warnings.length === 0 ? null : warnings.join('；'),
      }
    }

    // 包一层 try/catch：启动链路要读用户机器上的版本 JSON / 路径，坏数据不该让 RPC
    // 抛出一句英文堆栈（屏幕上必须是能看懂的一句话）。
    ctx.effect(() => harness.handle('atlas.launch', async (args) => {
      try {
        return await launchRequest(args)
      } catch (error) {
        return { error: '启动失败（宿主内部错误）：' + messageOf(error) }
      }
    }))

    ctx.effect(() => harness.handle('atlas.launchStatus', async (args) => {
      const request = args || {}
      const state = launchRun
      if (state === null) {
        return { running: false, pid: null, startedAt: null, exitCode: null, tail: [], logFile: null,
          versionId: null, stopped: false, note: null }
      }
      const text = await launchLogText(state.logFile)
      // 退出之后把日志收成尾部 200 行；运行中不能截（子进程的 fd 还开着）。
      if (state.running !== true && state.trimmed !== true) await launchTrimLog(state)
      const wantedLines = typeof request.lines === 'number' && request.lines > 0
        ? Math.min(400, Math.round(request.lines)) : LAUNCH_TAIL_LINES
      // 退出码非 0 时补一句**人话**：日志里那几句技术原话（拒绝访问 / LinkageError）
      // 用户看不懂，但"该把 gameDir 指到哪"他一眼就懂。
      let note = state.error
      if (note === null && state.running !== true && state.stopped !== true
        && state.exitCode !== null && state.exitCode !== 0) {
        if (/AccessDeniedException|拒绝访问|Access is denied/i.test(text)) {
          note = '游戏进程写不了自己的目录（日志 / config / mods 建不出来）。把 gameDir 指到一个它写得到的位置再启动 —— 面板里那个「用项目 run/」按钮就是干这个的。'
        } else if (/UnsupportedClassVersionError|has been compiled by a more recent version/i.test(text)) {
          note = 'Java 版本不对：这个版本要更新的 JDK。用 JDK 下拉换一个（1.18.2 要 Java 17）。'
        } else if (/Could not find or load main class|Unable to access jarfile|ClassNotFoundException/i.test(text)) {
          note = 'JVM 找不到主类或客户端 jar：游戏文件不全，或者类路径拼错了。'
        }
      }
      return {
        running: state.running === true,
        pid: state.pid,
        startedAt: state.startedAt,
        exitCode: state.exitCode,
        signal: state.signal,
        tail: launchTailLines(text, wantedLines),
        logFile: state.logFile,
        versionId: state.versionId,
        gameRoot: state.gameRoot,
        note: note,
      }
    }))

    ctx.effect(() => harness.handle('atlas.launchStop', async (args) => {
      const request = args || {}
      const state = launchRun
      if (state === null) {
        return { stopped: false, exitCode: null, pid: null, detail: '还没有启动过游戏（没有在跑的进程）' }
      }
      const result = await launchStop(state)
      return {
        stopped: result.stopped === true,
        exitCode: result.exitCode === undefined ? null : result.exitCode,
        pid: state.pid,
        signal: result.signal === undefined ? null : result.signal,
        detail: result.detail === undefined ? '' : result.detail,
      }
    }))
