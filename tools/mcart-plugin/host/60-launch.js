    // ── 轻量 Minecraft 启动器（host 半）──────────────────────────────────────────
    //
    // 为什么在面板里：改 mod 的循环是「装进 mods → 启动游戏 → 看一眼日志 → 关掉改」。
    // 外部启动器每轮都要切出去，还看不到面板里的工程状态。所以这里内置一个**只够调试**
    // 的启动器：选版本 / JDK / 内存、启动、看日志尾巴、停止。它不登录、不下载、不管理
    // 实例，但能把本机**已经装好的**那份游戏真正跑起来。
    //
    // 事实边界（都是本机量出来的，不要在这里猜）：
    //   · 版本 JSON 的键随形态变：现代是 `arguments.jvm` / `arguments.game`，1.12.2 是
    //     顶层 `minecraftArguments` 字符串。`inheritsFrom` 要把父版本合进来（libraries
    //     相加、参数相加、mainClass 继承）。
    //   · Java 必须**真跑一次 `-version`**：这台机器 PATH 上就是 21.0.7，而 1.18.2
    //     Forge 要 17；「文件在不在」不算数。17 的那份在游戏自带的
    //     `%APPDATA%\.minecraft\runtime\java-runtime-gamma-snapshot\bin\java.exe`。
    //   · 真启动的子进程由 `subprocess` 服务的 managed range 管：`terminate()` 杀整棵
    //     进程树（Windows 上走 taskkill /T）。所以面板不需要自己记 pid 去 taskkill。
    //   · 日志由**子进程**写（不是宿主轮询着写）：面板关掉的那段时间日志也在长。
    const LAUNCH_LOG_NAME = 'mc-art.launch.log'
    const LAUNCH_TAIL_LINES = 80           // `launchStatus` 回给界面的行数
    const LAUNCH_LOG_KEEP_LINES = 200      // 退出后日志文件保留的尾部行数
    const LAUNCH_PROBE_LIMIT = 40          // 最多真跑多少个 java -version
    const LAUNCH_MEMORY_MIN = 512
    const LAUNCH_MEMORY_MAX = 32768
    const LAUNCH_PLACEHOLDERS = [
      'classpath', 'classpath_separator', 'natives_directory', 'library_directory',
      'launcher_name', 'launcher_version', 'version_name', 'game_directory',
      'assets_root', 'assets_index_name', 'auth_player_name', 'auth_uuid',
      'auth_access_token', 'user_type', 'version_type', 'clientid', 'auth_xuid',
    ]

    /** 最近一次启动的状态；面板上同一时间只允许一个游戏在跑。 */
    let launchRun = null
    /** java 探测很短时间内的缓存（面板一开就会问一次，重复渲染不该重复起进程）。 */
    let launchJavaCache = { at: 0, key: '', value: null }

    function launchOsName() {
      const platform = platformOf()
      if (platform === 'win32') return 'windows'
      if (platform === 'darwin') return 'osx'
      if (platform === '') return ''
      return 'linux'
    }

    function launchOsArch() {
      const arch = (typeof process !== 'undefined' && process !== null && typeof process.arch === 'string')
        ? process.arch : ''
      if (arch === 'x64') return 'x86_64'
      if (arch === 'ia32') return 'x86'
      if (arch === 'arm64') return 'arm64'
      if (arch === 'arm') return 'arm32'
      return arch
    }

    function launchOsVersion() {
      if (launchOsName() !== 'windows') return ''
      if (typeof process !== 'undefined' && process !== null && typeof process.getSystemVersion === 'function') {
        try {
          const value = process.getSystemVersion()
          if (typeof value === 'string' && value !== '') return value
        } catch (error) { /* 退到下面那个保守值 */ }
      }
      return '10.0'
    }

    /**
     * Mojang 的 rules：没有 rules = 允许；有一条匹配就用它的 action，后面的接着覆盖。
     * `os.version` 是正则；`features` 面板里没有"开没开"的概念，只把 `false` 当匹配。
     */
    function launchRulesAllow(rules) {
      if (!Array.isArray(rules) || rules.length === 0) return true
      const osName = launchOsName()
      const osArch = launchOsArch()
      let allowed = false
      for (const rule of rules) {
        if (rule === null || typeof rule !== 'object') continue
        const target = rule.os !== null && rule.os !== undefined && typeof rule.os === 'object' ? rule.os : null
        if (target !== null) {
          if (typeof target.name === 'string' && target.name !== '' && target.name !== osName) continue
          if (typeof target.arch === 'string' && target.arch !== '' && target.arch !== osArch) continue
          if (typeof target.version === 'string' && target.version !== '') {
            let matched = false
            try { matched = new RegExp(target.version).test(launchOsVersion()) } catch (error) { matched = false }
            if (!matched) continue
          }
        }
        const features = rule.features !== null && rule.features !== undefined && typeof rule.features === 'object'
          ? rule.features : null
        if (features !== null) {
          let everyFalse = true
          for (const key of Object.keys(features)) if (features[key] !== false) everyFalse = false
          if (!everyFalse) continue
        }
        allowed = rule.action !== 'disallow'
      }
      return allowed
    }

    /** `arguments.jvm` / `arguments.game`：字符串或 `{rules,value}`，按 rules 过滤后摊平。 */
    function launchArgumentValues(list) {
      const out = []
      if (!Array.isArray(list)) return out
      for (const entry of list) {
        if (typeof entry === 'string') { out.push(entry); continue }
        if (entry === null || typeof entry !== 'object') continue
        if (!launchRulesAllow(entry.rules)) continue
        if (typeof entry.value === 'string') out.push(entry.value)
        else if (Array.isArray(entry.value)) for (const value of entry.value) if (typeof value === 'string') out.push(value)
      }
      return out
    }

    /** 1.12.2 那种顶层 `minecraftArguments` 字符串：按空格切，但尊重引号。 */
    function launchSplitLegacy(text) {
      const raw = String(text === undefined || text === null ? '' : text)
      const out = []
      let current = ''
      let quote = ''
      for (let index = 0; index < raw.length; index += 1) {
        const ch = raw.charAt(index)
        if (quote !== '') {
          if (ch === quote) quote = ''
          else current += ch
          continue
        }
        if (ch === '"' || ch === SQUOTE) { quote = ch; continue }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
          if (current !== '') { out.push(current); current = '' }
          continue
        }
        current += ch
      }
      if (current !== '') out.push(current)
      return out
    }

    /** `group:artifact:version[:classifier]` → maven 相对路径（缺 `downloads` 时用）。 */
    function launchMavenPath(name, classifier) {
      const parts = String(name === undefined || name === null ? '' : name).split(':')
      if (parts.length < 3) return ''
      const group = parts[0].split('.').join('/')
      const artifact = parts[1]
      const version = parts[2]
      const extra = classifier === undefined || classifier === null ? '' : String(classifier)
      let file = artifact + '-' + version
      if (extra !== '') file += '-' + extra
      return group + '/' + artifact + '/' + version + '/' + file + '.jar'
    }

    /**
     * 一条 library 的 jar 相对路径。`classifier` 是空串时取主 artifact；
     * 否则取 natives/classifier 那条。`downloads` 缺了就按 `name` 推 maven 路径
     * （老 Forge / mod 的 JSON 里有这种）。
     */
    function launchLibraryPath(library, classifier) {
      if (library === null || typeof library !== 'object') return ''
      const downloads = library.downloads !== null && library.downloads !== undefined
        && typeof library.downloads === 'object' ? library.downloads : null
      const want = classifier === undefined || classifier === null ? '' : String(classifier)
      if (downloads !== null) {
        if (want === '') {
          const artifact = downloads.artifact
          if (artifact !== null && artifact !== undefined && typeof artifact.path === 'string' && artifact.path !== '') {
            return artifact.path
          }
        } else {
          const table = downloads.classifiers
          const entry = table !== null && table !== undefined && typeof table === 'object' ? table[want] : null
          if (entry !== null && entry !== undefined && typeof entry.path === 'string' && entry.path !== '') {
            return entry.path
          }
        }
      }
      const name = typeof library.name === 'string' ? library.name : ''
      if (name === '') return ''
      // `name` 自己可能已经带 classifier 段（四段式），这种直接用。
      if (want !== '' && name.split(':').length >= 4) return launchMavenPath(name, '')
      return launchMavenPath(name, want)
    }

    /**
     * 读一份版本 JSON 并（按需）合并父版本。
     *
     * 合并规则（Mojang 启动器那一套）：libraries 父在前、子在后；arguments 相加；
     * mainClass 用子的、没有就继承父的；assets / assetIndex / type 同理。
     * 返回里 `clientJar` 是**客户端 jar 的版本目录名**（`jar` 字段可能是另一个版本 id，
     * 也可能是 `inherited`）。
     */
    async function launchResolveVersion(gameRoot, versionId, depth, seen) {
      const file = gameRoot + '/versions/' + versionId + '/' + versionId + '.json'
      const own = await readJson(file)
      if (own === null || own === undefined || typeof own !== 'object') {
        return { error: '找不到版本 JSON：' + file + '（这个版本目录里没有 ' + versionId + '.json）' }
      }
      if (seen[versionId] === true) {
        return { error: '版本继承成环了：' + Object.keys(seen).join(' → ') + ' → ' + versionId }
      }
      if (depth > 6) return { error: '版本继承链太深（超过 6 层）：' + versionId }
      seen[versionId] = true

      const parentId = typeof own.inheritsFrom === 'string' ? own.inheritsFrom : ''
      let base = {
        libraries: [], jvm: [], game: [], mainClass: '', assets: '', assetIndex: '',
        type: '', javaMajor: 0, clientJar: '', chain: [],
      }
      if (parentId !== '') {
        const parent = await launchResolveVersion(gameRoot, parentId, depth + 1, seen)
        if (parent.error !== undefined) return parent
        base = parent
      }

      const ownLibraries = Array.isArray(own.libraries) ? own.libraries : []
      // 同名 library 以子版本为准（父版本里那份是同一个坐标的旧条目时不该重复进 classpath）。
      const byName = new Map()
      for (const library of base.libraries) {
        const key = library !== null && typeof library === 'object' && typeof library.name === 'string'
          ? library.name : ''
        byName.set(key === '' ? '#' + byName.size : key, library)
      }
      for (const library of ownLibraries) {
        const key = library !== null && typeof library === 'object' && typeof library.name === 'string'
          ? library.name : ''
        byName.set(key === '' ? '#' + byName.size : key, library)
      }
      const libraries = Array.from(byName.values())

      const args = own.arguments !== null && own.arguments !== undefined && typeof own.arguments === 'object'
        ? own.arguments : null
      const ownJvm = args !== null && Array.isArray(args.jvm) ? args.jvm : []
      const ownGame = args !== null && Array.isArray(args.game) ? args.game : []
      const legacyGame = typeof own.minecraftArguments === 'string' ? launchSplitLegacy(own.minecraftArguments) : []

      const jarValue = typeof own.jar === 'string' ? own.jar : ''
      let clientJar = versionId
      if (jarValue !== '' && jarValue !== 'inherited') clientJar = jarValue
      else if (jarValue === 'inherited' && base.clientJar !== '') clientJar = base.clientJar

      const javaVersion = own.javaVersion !== null && own.javaVersion !== undefined
        && typeof own.javaVersion === 'object' ? own.javaVersion : null
      const ownJavaMajor = javaVersion !== null && typeof javaVersion.majorVersion === 'number'
        ? javaVersion.majorVersion : 0

      return {
        id: versionId,
        chain: (base.chain || []).concat([versionId]),
        libraries: libraries,
        jvm: (base.jvm || []).concat(ownJvm),
        game: ownGame.length > 0 ? (base.game || []).concat(ownGame)
          : (legacyGame.length > 0 ? legacyGame : (base.game || [])),
        mainClass: typeof own.mainClass === 'string' && own.mainClass !== '' ? own.mainClass : base.mainClass,
        assets: typeof own.assets === 'string' && own.assets !== '' ? own.assets : base.assets,
        assetIndex: launchAssetIndexOf(own) || base.assetIndex || '',
        type: typeof own.type === 'string' && own.type !== '' ? own.type : (base.type || 'release'),
        javaMajor: ownJavaMajor > 0 ? ownJavaMajor : (base.javaMajor || 0),
        clientJar: clientJar,
      }
    }

    function launchAssetIndexOf(version) {
      const index = version.assetIndex
      if (index !== null && index !== undefined && typeof index === 'object' && typeof index.id === 'string') return index.id
      return ''
    }

    /**
     * 把 `${…}` 换掉。**这里只能有一个替换点**：漏一个，JVM 会把字面量 `${classpath}`
     * 当路径，报出来的错和真正的原因差着十万八千里（门禁钉的就是这一条）。
     */
    function launchSubstitute(text, values) {
      const raw = String(text === undefined || text === null ? '' : text)
      let out = raw
      for (const key of LAUNCH_PLACEHOLDERS) {
        const token = '${' + key + '}'
        if (out.indexOf(token) < 0) continue
        const value = values[key]
        out = out.split(token).join(value === undefined || value === null ? '' : String(value))
      }
      // 版本 JSON / mod 里偶尔有清单外的占位符（`${auth_session}` 之类）：填空，
      // 并且把名字记下来，好让界面上说一句"这几个没替换"。
      return out.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, '')
    }

    /** 替换后还剩哪些占位符（给 dryRun / 诊断用；正常情况下应该空）。 */
    function launchLeftoverPlaceholders(args) {
      const found = []
      for (const arg of args) {
        const pattern = /\$\{([A-Za-z0-9_.-]+)\}/g
        let match = pattern.exec(String(arg))
        while (match !== null) {
          if (found.indexOf(match[1]) < 0) found.push(match[1])
          match = pattern.exec(String(arg))
        }
      }
      return found
    }

    function launchUniqueHash(text) {
      let hash = 5381
      const raw = String(text)
      for (let index = 0; index < raw.length; index += 1) {
        hash = (((hash * 33) >>> 0) ^ raw.charCodeAt(index)) >>> 0
      }
      return hash.toString(16)
    }

    // ── JDK 探测：每个候选都**真跑一次** `-version` ─────────────────────────────
    async function launchJavaHomesUnder(base, suffix) {
      const out = []
      const entries = await listDir(base)
      for (const entry of entries.slice(0, 24)) {
        if (entry.type !== 'directory') continue
        out.push(base + '/' + entry.name + (suffix === undefined ? '' : suffix))
      }
      return out
    }

    async function launchJavaCandidates(gameRoots) {
      const osName = launchOsName()
      const exe = osName === 'windows' ? '/bin/java.exe' : '/bin/java'
      const out = []
      const seen = {}
      const push = (value, source) => {
        if (typeof value !== 'string' || value === '') return
        const key = value.toLowerCase()
        if (seen[key] === true) return
        seen[key] = true
        out.push({ path: value, source: source === undefined ? '' : source })
      }
      const home = envOf('USERPROFILE') || envOf('HOME')
      const appData = envOf('APPDATA') || (home === '' ? '' : home + '/AppData/Roaming')
      const localAppData = envOf('LOCALAPPDATA') || (home === '' ? '' : home + '/AppData/Local')
      // 1) 显式指定（和 `MC_ART_PYTHON` 同一个体例）。
      push(envOf('MC_ART_JAVA'), 'MC_ART_JAVA')
      // 2) JAVA_HOME
      const javaHome = envOf('JAVA_HOME')
      if (javaHome !== '') push(javaHome + exe, 'JAVA_HOME')
      // 3) 游戏自带的 runtime（Mojang 启动器装的那几个；1.18.2 的 17 就在这儿）。
      //    注意这是 `%APPDATA%\.minecraft\runtime`（启动器自己那份），不一定等于游戏根；
      //    这里两条都看：APPDATA 那份 + 每个游戏根下的 runtime。
      const runtimeBases = []
      if (appData !== '') runtimeBases.push(appData + '/.minecraft/runtime')
      for (const gameRoot of gameRoots) runtimeBases.push(gameRoot + '/runtime')
      for (const base of runtimeBases.slice(0, 4)) {
        const entries = await listDir(base)
        for (const entry of entries.slice(0, 16)) {
          if (entry.type !== 'directory') continue
          push(base + '/' + entry.name + exe, 'game-runtime')
        }
      }
      // 4) PATH 上的 java（让 subprocess 服务按它自己的执行世界解析）
      push('java', 'PATH')
      // 5) 常见安装目录
      if (osName === 'windows') {
        const bases = [
          'C:/Program Files/Java', 'C:/Program Files (x86)/Java',
          'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Microsoft',
          'C:/Program Files/Zulu', 'C:/Program Files/Amazon Corretto',
          'C:/Program Files/BellSoft', 'C:/Program Files/Android/Android Studio/jbr',
          'C:/Program Files (x86)/Eclipse Adoptium',
        ]
        for (const base of bases) for (const found of await launchJavaHomesUnder(base, exe)) push(found, 'installed')
        if (home !== '') {
          for (const found of await launchJavaHomesUnder(home + '/.jdks', exe)) push(found, 'installed')
          for (const found of await launchJavaHomesUnder(home + '/.gradle/jdks', exe)) push(found, 'installed')
          for (const found of await launchJavaHomesUnder(home + '/.sdkman/candidates/java', exe)) push(found, 'installed')
        }
        if (localAppData !== '') {
          for (const found of await launchJavaHomesUnder(localAppData + '/Programs/Eclipse Adoptium', exe)) push(found, 'installed')
        }
      } else {
        for (const base of ['/usr/lib/jvm', '/usr/java', '/opt/java', '/opt']) {
          for (const found of await launchJavaHomesUnder(base, exe)) push(found, 'installed')
        }
        if (home !== '') for (const found of await launchJavaHomesUnder(home + '/.jdks', exe)) push(found, 'installed')
      }
      return out.slice(0, LAUNCH_PROBE_LIMIT)
    }

    function launchJavaVersionOf(text) {
      const raw = String(text === undefined || text === null ? '' : text)
      // `java version "1.8.0_511"` / `openjdk version "17.0.8" 2023-07-18`
      // 注意：引号写成 `\u0022`，不要在正则字面量里直接放 `"` —— 门禁的注释剥离器不解析
      // 正则字面量，会把那个引号当成字符串开头，状态一路错位（实测：report-test 的
      // "内嵌源码 == 拼接源码" 因此变红）。
      const quoted = /version\s+\u0022?([0-9][0-9._+\-]*)/i.exec(raw)
      const bare = /(?:^|\s)([0-9]+\.[0-9]+\.[0-9][0-9._+\-]*)/.exec(raw)
      const token = quoted !== null ? quoted[1] : (bare !== null ? bare[1] : '')
      if (token === '') return null
      const numbers = token.split(/[._+\-]/)
      const first = Number(numbers[0])
      if (!(first > 0)) return null
      const major = first === 1 && numbers.length > 1 ? Number(numbers[1]) : first
      if (!(major > 0)) return null
      return { version: token, major: major }
    }

    /**
     * 一个候选 JDK 到底能不能用：**真的跑 `-version`**，解析 major。
     * 失败要带原因（文件不在 / PATH 解析不到 / 退出码 / 认不出版本），UI 要能说人话。
     */
    async function launchProbeJava(candidate) {
      let path = candidate.path
      if (isPathLike(path)) {
        const info = await statOf(path)
        if (info === undefined || info.type !== 'file') {
          return { ok: false, path: candidate.path, source: candidate.source, why: '文件不在' }
        }
      } else {
        let resolved = null
        try { resolved = await resolveExecutable(path) } catch (error) { resolved = null }
        if (resolved === null) {
          return { ok: false, path: candidate.path, source: candidate.source, why: 'PATH 里没有这个命令' }
        }
        path = resolved
      }
      let text = ''
      let exitCode = null
      let via = ''
      const argvRun = await Promise.race([
        runProcess([path, '-version'], { maxBytes: 64 * 1024, graceMs: 3000 }).catch(() => null),
        launchDelay(15000).then(() => null),
      ])
      if (argvRun !== null) {
        text = String(argvRun.text === undefined ? '' : argvRun.text) + '\n'
          + String(argvRun.err === undefined ? '' : argvRun.err)
        exitCode = argvRun.exitCode
        via = 'subprocess'
      } else if (shellOf() !== undefined) {
        const dialect = await currentShell('')
        const result = await runShell(dialect.word(path) + ' -version', 15000, undefined, 64 * 1024)
        text = String(result.text === undefined ? '' : result.text) + '\n'
          + String(result.err === undefined ? '' : result.err)
        exitCode = result.exitCode
        via = 'shell'
      } else {
        return { ok: false, path: path, source: candidate.source, why: '宿主既没有 subprocess 也没有 shell' }
      }
      const parsed = launchJavaVersionOf(text)
      if (parsed === null) {
        const first = text.split('\n').filter((line) => line.trim() !== '')[0] || ''
        return { ok: false, path: path, source: candidate.source, why: '认不出版本（exit=' + String(exitCode) + (first === '' ? '' : '，' + first.trim().slice(0, 80)) + '）' }
      }
      return { ok: true, path: path, source: candidate.source, version: parsed.version,
        major: parsed.major, exitCode: exitCode, via: via }
    }

    async function launchProbeJavas(gameRoots) {
      const key = gameRoots.join('|')
      const now = Date.now()
      if (launchJavaCache.value !== null && launchJavaCache.key === key && now - launchJavaCache.at < 15000) {
        return launchJavaCache.value
      }
      const candidates = await launchJavaCandidates(gameRoots)
      const probed = []
      for (const candidate of candidates) {
        const result = await launchProbeJava(candidate)
        if (result.ok === true) probed.push(result)
        else probed.push({ path: result.path, source: result.source, ok: false, why: result.why })
      }
      const good = probed.filter((item) => item.ok === true)
      // 17 排最前（1.18.2 这一代要它），其余按 major 从新到旧。
      good.sort((left, right) => {
        const leftRank = left.major === 17 ? 0 : 1
        const rightRank = right.major === 17 ? 0 : 1
        if (leftRank !== rightRank) return leftRank - rightRank
        return right.major - left.major
      })
      const bad = probed.filter((item) => item.ok !== true).slice(0, 8)
      launchJavaCache = { at: now, key: key, value: { javas: good, rejected: bad } }
      return launchJavaCache.value
    }

    // ── 从设置里的参考目录反推游戏根 ─────────────────────────────────────────────
    function launchTrimPath(value) {
      let at = String(value === undefined || value === null ? '' : value)
      while (at.length > 1 && (at.charAt(at.length - 1) === '/' || at.charAt(at.length - 1) === BACKSLASH)) {
        at = at.slice(0, at.length - 1)
      }
      return at
    }

    /** 一个目录往上找：哪一层同时有 versions/（或 libraries/、assets/）就是游戏根。 */
    async function launchGameRootOf(path) {
      let at = launchTrimPath(path)
      if (at === '') return ''
      for (let depth = 0; depth < 4; depth += 1) {
        const info = await statOf(at)
        if (info === undefined || info.type !== 'directory') return ''
        for (const marker of ['versions', 'libraries', 'assets']) {
          const found = await statOf(at + '/' + marker)
          if (found !== undefined && found.type === 'directory') return at
        }
        const up = parentOf(at)
        if (up === null || up === '') return ''
        at = up
      }
      return ''
    }

    async function launchProjectDir(root, projectId) {
      if (root === '') return ''
      const id = projectId === null || projectId === undefined ? '' : String(projectId)
      if (id !== '') {
        const direct = launchTrimPath(root) + '/' + id
        if ((await statOf(direct + '/mc-art.atlas.json')) !== undefined) return direct
      }
      const project = await projectFor(root, id)
      return project === undefined ? '' : project.dir
    }

    async function launchSettingsDirectory(projectDir) {
      if (projectDir === '') return ''
      const stored = await readJson(projectDir + '/mc-art.settings.json')
      if (stored === null || stored === undefined || typeof stored !== 'object') return ''
      const reference = stored.reference !== null && stored.reference !== undefined && typeof stored.reference === 'object'
        ? stored.reference : null
      return reference !== null && typeof reference.directory === 'string' ? reference.directory : ''
    }

    async function launchGameRootsNear(near, settingsDirectory, explicit) {
      const out = []
      const add = (value) => {
        const trimmed = launchTrimPath(value)
        if (trimmed === '' || out.indexOf(trimmed) >= 0) return
        out.push(trimmed)
      }
      if (explicit !== '') {
        const root = await launchGameRootOf(explicit)
        if (root !== '') add(root)
      }
      if (settingsDirectory !== '') {
        const root = await launchGameRootOf(settingsDirectory)
        if (root !== '') add(root)
      }
      for (const detected of await detectGameRoots(near)) add(detected)
      return out.slice(0, 6)
    }

    // ── 日志尾巴 ────────────────────────────────────────────────────────────────
    async function launchLogText(logFile) {
      const text = await readTextOf(logFile)
      return typeof text === 'string' ? text : ''
    }

    function launchTailLines(text, limit) {
      const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      return lines.slice(-(limit === undefined ? LAUNCH_TAIL_LINES : limit))
    }

    /** 进程退出之后把日志收成最后 200 行（运行中不能截：子进程的 fd 还开着）。 */
    async function launchTrimLog(state) {
      if (state === null || state.trimmed === true || state.running === true) return false
      const text = await launchLogText(state.logFile)
      if (text === '') { state.trimmed = true; return false }
      const lines = String(text).split(/\r?\n/)
      // 末尾的空行不算行：不然截 200 行会少一行（门禁实测 199）。
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      if (lines.length <= LAUNCH_LOG_KEEP_LINES) { state.trimmed = true; return false }
      const kept = lines.slice(-LAUNCH_LOG_KEEP_LINES).join('\n') + '\n'
      const wrote = await writeTextFile(state.logFile, kept, state.logDir)
      if (wrote !== null && wrote !== undefined && wrote.ok === true) { state.trimmed = true; return true }
      return false
    }

    async function launchAppendLog(state, line) {
      if (state === null) return false
      const text = await launchLogText(state.logFile)
      const next = (text === '' || text.charAt(text.length - 1) === '\n' ? text : text + '\n') + line + '\n'
      const wrote = await writeTextFile(state.logFile, next, state.logDir)
      return wrote !== null && wrote !== undefined && wrote.ok === true
    }

    // ── natives 解压 ────────────────────────────────────────────────────────────
    function launchShellQuote(value) {
      // POSIX 单引号：内部的 ' 用 '\'' 关开一次。
      return SQUOTE + String(value).split(SQUOTE).join(SQUOTE + BACKSLASH + SQUOTE + SQUOTE) + SQUOTE
    }

    function launchPowerShellQuote(value) {
      // PowerShell 单引号字符串：内部的 ' 写两遍。
      return SQUOTE + String(value).split(SQUOTE).join(SQUOTE + SQUOTE) + SQUOTE
    }

    /**
     * 把一个 zip/jar 解到目录。Windows 优先 `tar.exe`（bsdtar 能读 zip），
     * 退 `Expand-Archive`，POSIX 退 `unzip`。返回里带 via，失败带 detail。
     */
    async function launchExtractZip(jar, dest, workspaceRoot) {
      const failed = []
      const attempts = []
      if (launchOsName() === 'windows') {
        attempts.push({ via: 'tar', argv: ['tar', '-xf', jar, '-C', dest] })
        const powerShell = await windowsPowerShell()
        if (powerShell !== null) {
          attempts.push({ via: 'powershell', argv: [powerShell, '-NoProfile', '-NonInteractive', '-Command',
            'Expand-Archive -LiteralPath ' + launchPowerShellQuote(jar)
            + ' -DestinationPath ' + launchPowerShellQuote(dest) + ' -Force'] })
        }
      } else {
        attempts.push({ via: 'unzip', argv: ['unzip', '-o', '-q', jar, '-d', dest] })
        attempts.push({ via: 'tar', argv: ['tar', '-xf', jar, '-C', dest] })
      }
      for (const attempt of attempts) {
        const done = await runProcess(attempt.argv, { cwd: dest, maxBytes: 64 * 1024, graceMs: 5000 })
        if (done !== null) {
          if (done.exitCode === 0) return { ok: true, via: attempt.via }
          const detail = beforeStderr(String(done.err === undefined ? '' : done.err))
            || beforeStderr(String(done.text === undefined ? '' : done.text))
          failed.push(attempt.via + ' exit=' + String(done.exitCode) + (detail === '' ? '' : '：' + detail.slice(0, 160)))
          continue
        }
        failed.push(attempt.via + '：宿主没有 subprocess 服务')
      }
      // subprocess 不在时还能用一次 shell（与探测同一条退路）。
      if (shellOf() !== undefined) {
        const dialect = await currentShell(workspaceRoot)
        const command = launchOsName() === 'windows'
          ? 'tar -xf ' + dialect.word(jar) + ' -C ' + dialect.word(dest)
          : 'unzip -o -q ' + dialect.word(jar) + ' -d ' + dialect.word(dest)
        const done = await runShell(command, 60000, policyFor(workspaceRoot), 64 * 1024)
        if (done.exitCode === 0) return { ok: true, via: 'shell' }
        failed.push('shell exit=' + String(done.exitCode))
      }
      return { ok: false, detail: failed.join('；') }
    }

    function launchNativesDirOf(gameRoot, versionId, natives) {
      if (natives.length === 0) return gameRoot + '/versions/' + versionId + '/natives'
      const wanted = natives.map((entry) => entry.path)
      const hash = launchUniqueHash(versionId + '|' + wanted.join('|'))
      return gameRoot + '/versions/' + versionId + '/natives-' + hash
    }

    /**
     * 解 natives 到 `<gameRoot>/versions/<id>/natives-<hash>`。
     * 目录名带 hash：换 LWJGL 版本/换平台就是另一个目录，不会把上一版的 .dll 混进来。
     * 已存在且清单一致（marker 里记着解了哪几个 jar）就跳过。
     */
    async function launchEnsureNatives(gameRoot, versionId, natives, workspaceRoot) {
      const dir = launchNativesDirOf(gameRoot, versionId, natives)
      if (natives.length === 0) return { dir: dir, skipped: true, extracted: 0, failures: [] }
      const wanted = natives.map((entry) => entry.path)
      const marker = dir + '/.mcart-natives.json'
      const existing = await readJson(marker)
      if (existing !== null && existing !== undefined && typeof existing === 'object' && Array.isArray(existing.jars)
        && existing.jars.join('|') === wanted.join('|') && (await statOf(dir)) !== undefined) {
        return { dir: dir, skipped: true, extracted: 0, failures: [] }
      }
      const made = await ensureDir(dir, workspaceRoot)
      if (made.ok !== true) {
        return { error: '建不出 natives 目录：' + dir + (made.detail === undefined ? '' : '（' + String(made.detail) + '）') }
      }
      let extracted = 0
      const failures = []
      for (const native of natives) {
        const outcome = await launchExtractZip(native.jar, dir, workspaceRoot)
        if (outcome.ok === true) extracted += 1
        else failures.push(native.path + '：' + String(outcome.detail))
      }
      if (extracted === 0) {
        return { error: 'natives 一个都没解出来（' + failures.slice(0, 3).join('；') + '）', dir: dir, failures: failures }
      }
      const wrote = await writeTextFile(marker, JSON.stringify({ schema: 'mc-art.natives/1', jars: wanted }, null, 2) + '\n', workspaceRoot)
      return { dir: dir, skipped: false, extracted: extracted, failures: failures,
        marker: wrote !== null && wrote !== undefined && wrote.ok === true }
    }

    // ── 参数拼装 ────────────────────────────────────────────────────────────────
    function launchUuidOffline() {
      return '00000000000000000000000000000000'
    }

    async function launchBuild(request) {
      const gameRoot = launchTrimPath(request.gameRoot)
      const versionId = String(request.versionId === undefined || request.versionId === null ? '' : request.versionId)
      if (gameRoot === '') return { error: '没有给定游戏根（.minecraft 目录）' }
      if (versionId === '') return { error: '没有选择版本' }
      if ((await statOf(gameRoot + '/versions')) === undefined) {
        return { error: '这个目录里没有 versions/：' + gameRoot + '（它看起来不是游戏根）' }
      }
      const merged = await launchResolveVersion(gameRoot, versionId, 0, {})
      if (merged.error !== undefined) return merged
      const osName = launchOsName()
      if (osName === '') return { error: '认不出当前平台（process.platform 为空），拼不出启动参数' }

      const gameDir = launchTrimPath(request.gameDir) || gameRoot
      const memoryMb = Math.max(LAUNCH_MEMORY_MIN, Math.min(LAUNCH_MEMORY_MAX,
        Math.round(Number(request.memoryMb === undefined || request.memoryMb === null ? 4096 : request.memoryMb) || 4096)))

      const libraries = []
      const classpath = []
      const missing = []
      for (const library of merged.libraries) {
        if (!launchRulesAllow(library.rules)) continue
        libraries.push(library)
        const relative = launchLibraryPath(library, '')
        if (relative === '') continue
        classpath.push(gameRoot + '/libraries/' + relative)
      }
      // 客户端 jar：`jar` 字段可能指向另一个版本目录；带 `inherit` 的先用父的。
      let clientJar = gameRoot + '/versions/' + merged.clientJar + '/' + merged.clientJar + '.jar'
      if ((await statOf(clientJar)) === undefined && merged.clientJar !== versionId) {
        const fallback = gameRoot + '/versions/' + versionId + '/' + versionId + '.jar'
        if ((await statOf(fallback)) !== undefined) clientJar = fallback
      }
      if (classpath.indexOf(clientJar) < 0) classpath.push(clientJar)

      // 缺文件要**点名**：只说"启动失败"没人能修。
      for (const entry of classpath) {
        if ((await statOf(entry)) === undefined) missing.push(entry)
      }

      // natives
      const natives = []
      for (const library of libraries) {
        const table = library.natives
        if (table === null || table === undefined || typeof table !== 'object') continue
        const classifier = table[osName]
        if (typeof classifier !== 'string' || classifier === '') continue
        const relative = launchLibraryPath(library, classifier)
        if (relative === '') continue
        natives.push({ path: relative, jar: gameRoot + '/libraries/' + relative })
      }
      const nativesPrepared = request.dryRun === true
        ? { dir: launchNativesDirOf(gameRoot, versionId, natives), skipped: true, extracted: 0, failures: [] }
        : await launchEnsureNatives(gameRoot, versionId, natives, gameRoot)
      if (nativesPrepared.error !== undefined) return nativesPrepared

      const values = {
        classpath: classpath.join(osName === 'windows' ? ';' : ':'),
        classpath_separator: osName === 'windows' ? ';' : ':',
        natives_directory: nativesPrepared.dir,
        library_directory: gameRoot + '/libraries',
        launcher_name: 'mc-art',
        launcher_version: '1',
        version_name: versionId,
        game_directory: gameDir,
        assets_root: gameRoot + '/assets',
        assets_index_name: merged.assetIndex || merged.assets || '',
        auth_player_name: 'Player',
        auth_uuid: launchUuidOffline(),
        auth_access_token: '0',
        user_type: 'legacy',
        version_type: merged.type || 'release',
        clientid: '',
        auth_xuid: '0',
      }

      const jvmArgs = launchArgumentValues(merged.jvm)
      const gameArgs = launchArgumentValues(merged.game)
      // 1.12.2 没有 arguments.jvm：至少把 natives 目录告诉 JVM，否则 LWJGL 找不到 .dll。
      if (jvmArgs.every((arg) => arg.indexOf('java.library.path') < 0)) {
        jvmArgs.unshift('-Djava.library.path=${natives_directory}')
      }
      const substitutedJvm = jvmArgs.map((arg) => launchSubstitute(arg, values))
      const substitutedGame = gameArgs.map((arg) => launchSubstitute(arg, values))

      // `-cp` 的位置是**规定**的：`java <jvm args> -cp <classpath> <mainClass> <game args>`。
      // 版本 JSON 自己也可能带 `-cp`（Forge 就有），但它不一定在最后；所以这里把
      // 所有 `-cp`/`-classpath` 连同它后面那个值一起摘掉，最后统一补一份。
      const jvmWithoutClasspath = []
      for (let index = 0; index < substitutedJvm.length; index += 1) {
        const token = substitutedJvm[index]
        if (token === '-cp' || token === '-classpath') { index += 1; continue }
        jvmWithoutClasspath.push(token)
      }

      const head = []
      head.push('-Xms' + Math.max(256, Math.round(memoryMb / 4)) + 'm')
      head.push('-Xmx' + memoryMb + 'm')
      if (osName === 'windows') head.push('-Dfile.encoding=UTF-8')
      const extra = Array.isArray(request.extraArgs) ? request.extraArgs.filter((item) => typeof item === 'string' && item !== '') : []
      // 内存 / 编码 / 调用方附加的 JVM 参数都在版本 JSON 的参数**之前**；`-cp` 统一收在
      // jvm 参数末尾，mainClass 紧跟着它。
      const finalJvm = head.concat(extra, jvmWithoutClasspath, ['-cp', values.classpath])
      const finalArgs = finalJvm.concat([merged.mainClass], substitutedGame)
      const leftover = launchLeftoverPlaceholders(finalArgs)

      return {
        gameRoot: gameRoot,
        gameDir: gameDir,
        versionId: versionId,
        chain: merged.chain,
        mainClass: merged.mainClass,
        args: finalArgs,
        classpath: classpath,
        clientJar: clientJar,
        nativesDir: nativesPrepared.dir,
        natives: natives.map((entry) => entry.path),
        nativesSkipped: nativesPrepared.skipped === true,
        nativesExtracted: nativesPrepared.extracted,
        nativesFailures: nativesPrepared.failures,
        missing: missing,
        leftover: leftover,
        memoryMb: memoryMb,
        javaMajor: merged.javaMajor,
        assetIndex: values.assets_index_name,
        logFile: '',
        logDir: '',
      }
    }

    // ── 真启动：一个 node 包装进程负责起 java + 写日志 ─────────────────────────
    //
    // 为什么要多一层包装进程（而不是直接 spawn java）：
    //   1. `subprocess` 的 handle 不暴露 pid —— 包装进程自己把 pid 写进日志，界面才有
    //      "运行中 · pid 1234" 可看；停止走 handle.terminate()（managed range 杀整棵树）；
    //   2. 日志要**持续**写：面板关掉/不轮询的时候子进程照样在写，所以写日志这件事
    //      必须属于子进程，而不是宿主每 700ms 轮询着补。
    // 这层包装不解析/不转发 stdin，退出码原样透传：`done.exitCode` 就是 java 的退出码。
    const LAUNCH_WRAPPER = [
      "const cp=require('child_process'),fs=require('fs');",
      'const s=JSON.parse(process.argv[1]);',
      'const fd=fs.openSync(s.log,"w");',
      'function w(x){try{fs.writeSync(fd,x)}catch(e){}}',
      'w(s.header);',
      'const opts={cwd:s.cwd,stdio:["ignore","pipe","pipe"],windowsHide:true};',
      'if(process.platform==="win32"&&/\\.(cmd|bat)$/i.test(s.argv[0]))opts.shell=true;',
      'let c;try{c=cp.spawn(s.argv[0],s.argv.slice(1),opts)}catch(e){w("[mc-art] spawn failed: "+String(e&&e.message||e)+"\\n");process.exit(2)}',
      'w("[mc-art] pid="+c.pid+"\\n");',
      'c.stdout.on("data",function(d){w(d)});',
      'c.stderr.on("data",function(d){w(d)});',
      'c.on("error",function(e){w("[mc-art] process error: "+String(e&&e.message||e)+"\\n")});',
      'c.on("exit",function(code,signal){w("[mc-art] exit code="+code+" signal="+signal+"\\n");try{fs.closeSync(fd)}catch(e){};process.exit(code===null?3:code)});',
    ].join('')

    function launchExecPath() {
      if (typeof process === 'undefined' || process === null) return ''
      if (typeof process.execPath !== 'string' || process.execPath === '') return ''
      return process.execPath
    }

    /** 等一小会儿：优先宿主 timer，其次 node 的 setTimeout；两样都没有就不等（不挂死）。 */
    async function launchDelay(ms) {
      const timer = ctx.get('timer')
      if (timer !== undefined && typeof timer.timeout === 'function') {
        try { await timer.timeout(ms); return true } catch (error) { /* 落到下面 */ }
      }
      if (typeof setTimeout === 'function') {
        await new Promise((resolve) => setTimeout(resolve, ms))
        return true
      }
      return false
    }

    async function launchWaitExit(state, timeoutMs) {
      const started = Date.now()
      while (state.doneSettled !== true && Date.now() - started < timeoutMs) {
        if (!(await launchDelay(100))) break
      }
      return state.doneSettled === true
    }

    async function launchStop(state) {
      if (state === null) return { stopped: false, exitCode: null, detail: '没有在跑的游戏' }
      if (state.running !== true) {
        return { stopped: false, exitCode: state.exitCode, detail: '游戏已经退出了' }
      }
      let signalError = null
      try {
        if (state.handle !== null && typeof state.handle.terminate === 'function') state.handle.terminate()
        else signalError = '这个宿主返回的 subprocess handle 没有 terminate()'
      } catch (error) {
        signalError = messageOf(error)
      }
      const exited = await launchWaitExit(state, 15000)
      if (exited !== true) {
        return { stopped: false, exitCode: state.exitCode, detail: signalError === null
          ? '发过停止信号，但 15 秒内没等到进程退出（它可能还在跑）'
          : '停止失败：' + signalError }
      }
      state.running = false
      state.stopped = true
      await launchAppendLog(state, '[mc-art] stopped by panel')
      await launchTrimLog(state)
      return { stopped: true, exitCode: state.exitCode, signal: state.signal, detail: '已停止' }
    }

    async function launchStart(built, logDir) {
      const service = subprocessOf()
      if (service === undefined || typeof service.spawn !== 'function') {
        return { error: '宿主没有 subprocess 服务，起不了游戏进程（面板只能在有 subprocess 的宿主里启动游戏）' }
      }
      const execPath = launchExecPath()
      if (execPath === '') return { error: '宿主拿不到 process.execPath，起不了启动器的包装进程' }
      const logFile = logDir + '/' + LAUNCH_LOG_NAME
      const madeDir = await ensureDir(logDir, logDir)
      if (madeDir.ok !== true) {
        return { error: '建不出日志目录：' + logDir + (madeDir.detail === undefined ? '' : '（' + String(madeDir.detail) + '）') }
      }
      const header = '[mc-art] launch version=' + built.versionId + '\n'
        + '[mc-art] java=' + String(built.command[0]) + '\n'
        + '[mc-art] gameDir=' + built.gameDir + '\n'
        + '[mc-art] memory=' + built.memoryMb + 'm\n'
      const spec = JSON.stringify({
        argv: built.command,
        cwd: built.gameDir,
        log: logFile,
        header: header,
      })
      let handle = null
      try {
        handle = service.spawn({
          argv: [execPath, '-e', LAUNCH_WRAPPER, spec],
          cwd: built.gameDir,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
          graceMs: 5000,
          env: { ELECTRON_RUN_AS_NODE: '1' },
        })
      } catch (error) {
        return { error: '起不了启动器进程：' + messageOf(error) }
      }
      const startedAt = new Date().toISOString()
      const state = {
        handle: handle,
        pid: null,
        startedAt: startedAt,
        exitCode: null,
        signal: null,
        running: true,
        doneSettled: false,
        trimmed: false,
        stopped: false,
        error: null,
        logFile: logFile,
        logDir: logDir,
        versionId: built.versionId,
        gameRoot: built.gameRoot,
      }
      launchRun = state
      try {
        handle.done.then((outcome) => {
          state.running = false
          state.doneSettled = true
          state.exitCode = outcome === null || outcome === undefined ? null : (outcome.exitCode === undefined ? null : outcome.exitCode)
          state.signal = outcome === null || outcome === undefined ? null : (outcome.signal === undefined ? null : outcome.signal)
        }, (error) => {
          state.running = false
          state.doneSettled = true
          state.exitCode = null
          state.error = '子进程协议错误：' + messageOf(error)
        })
      } catch (error) { /* handle.done 不是 thenable 也不该把启动弄死 */ }
      // 包装进程一上来就写 `[mc-art] pid=…`；最多等 5 秒（真机上通常是几十毫秒）。
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const text = await launchLogText(logFile)
        const match = /\[mc-art\] pid=(\d+)/.exec(text)
        if (match !== null) { state.pid = Number(match[1]); break }
        if (state.doneSettled === true) break
        if (!(await launchDelay(100))) break
      }
      if (state.doneSettled === true && state.pid === null) {
        await launchTrimLog(state)
        return { error: '启动器进程立刻退出了' + (state.error === null ? '' : '：' + state.error)
          + '（日志：' + launchTailLines(await launchLogText(logFile), 6).join(' ｜ ') + '）' }
      }
      return {
        startedAt: startedAt,
        pid: state.pid,
        logFile: logFile,
        versionId: built.versionId,
        mainClass: built.mainClass,
        nativesDir: built.nativesDir,
        memoryMb: built.memoryMb,
        argsCount: built.args.length - 1,
        javaMajor: built.javaMajor,
        warning: built.leftover.length === 0 ? null
          : '参数里有没替换掉的占位符：' + built.leftover.join('、'),
      }
    }
