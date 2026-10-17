    // Where might a Minecraft installation be?  Asked of the filesystem, not of
    // the shell: fs reads behave the same on Windows, WSL and Linux.  Nothing is
    // invented -- a candidate is listed only because it exists on disk, and an
    // unreadable parent simply yields no candidates instead of a guess.
    // ── 参考目录的候选：**只靠 fs**，按平台给候选，再 stat 掉不存在的 ────────────
    //
    // 这一段原来是 WSL 形状的：只看 `/root/.minecraft`、`/mnt/c/Users/<user>/…`、
    // `/home/<user>/…`。在原生 Windows 上它一条都不成立 —— 于是设置页"检测到 … 用它"
    // 那一栏永远是空的，而"选择目录…"在某些环境里根本弹不出来（shell 服务跑在非交互
    // 窗口站上时，FolderBrowserDialog 既不显示也不返回），于是用户点开设置，
    // **没有任何办法指定参考目录**，界面上也没有一句话解释。
    // 现在：平台候选（Windows/macOS/Linux）+ 工程旁边 + 实例目录展开一层，逐个 stat。
    const envOf = (name) => {
      if (typeof process === 'undefined' || process.env === undefined) return ''
      const value = process.env[name]
      return typeof value === 'string' ? value : ''
    }

    /** 平台：`process.platform`，问不到就空串（动态插件那种环境）。 */
    function platformOf() {
      if (typeof process === 'undefined' || process === null) return ''
      return typeof process.platform === 'string' ? process.platform : ''
    }

    /** 本模块所在目录（<包>/lib）——随包的那份引擎、以及捆绑运行时都从这里推。 */
    function moduleDirOf() {
      if (typeof moduleDir !== 'undefined' && typeof moduleDir === 'string') return moduleDir
      return ''
    }

    /** 纯函数：按环境给候选（不碰盘），好单独测。 */
    function gameRootCandidates(near) {
      const home = envOf('USERPROFILE') || envOf('HOME')
      const roaming = envOf('APPDATA') || (home === '' ? '' : home + '/AppData/Roaming')
      const out = []
      const push = (value) => {
        if (typeof value !== 'string' || value === '') return
        const trimmed = value.charAt(value.length - 1) === '/' ? value.slice(0, value.length - 1) : value
        if (trimmed !== '' && out.indexOf(trimmed) < 0) out.push(trimmed)
      }
      // 标准安装位置：Windows 是 %APPDATA%\.minecraft，macOS 是
      // ~/Library/Application Support/minecraft，Linux 是 ~/.minecraft。
      push(roaming === '' ? '' : roaming + '/.minecraft')
      push(home === '' ? '' : home + '/.minecraft')
      push(home === '' ? '' : home + '/Library/Application Support/minecraft')
      push(roaming === '' ? '' : roaming + '/com.mojang/minecraft')
      // 第三方启动器的实例目录（它们是**容器**，真正的游戏目录在子目录里）。
      push(home === '' ? '' : home + '/curseforge/minecraft/Instances')
      push(roaming === '' ? '' : roaming + '/PrismLauncher/instances')
      push(roaming === '' ? '' : roaming + '/MultiMC/instances')
      // 就在工程旁边：模组开发工作区常见 `<repo>/.minecraft`、`<repo>/run`。
      const here = typeof near === 'string' ? near : ''
      for (const base of [here, parentOf(here)]) {
        if (typeof base !== 'string' || base === '') continue
        push(base + '/.minecraft')
        push(base + '/run')
      }
      // WSL 里也能看 Windows 那一侧（旧行为里唯一在 WSL 上真有用的那条）。
      push('/root/.minecraft')
      return out
    }

    const INSTANCE_DIR = /(Instances|instances)$/
    async function looksLikeGameRoot(path) {
      for (const marker of ['versions', 'mods', 'assets', 'config']) {
        const info = await statOf(path + '/' + marker)
        if (info !== undefined && info.type === 'directory') return true
      }
      return false
    }

    async function detectGameRoots(near) {
      const candidates = gameRootCandidates(near)
      const out = []
      const consider = async (path) => {
        const info = await statOf(path)
        if (info === undefined || info.type !== 'directory' || out.indexOf(path) >= 0) return false
        out.push(path)
        return true
      }
      // WSL：Windows 侧的用户目录（原生 Windows 上这一步自然什么也列不出来）。
      if ((typeof process === 'undefined' ? '' : process.platform) !== 'win32') {
        const skip = { Public: true, Default: true, 'Default User': true, 'All Users': true }
        for (const user of (await listDir('/mnt/c/Users')).slice(0, 8)) {
          if (user.type !== 'directory' || skip[user.name] === true) continue
          candidates.push('/mnt/c/Users/' + user.name + '/AppData/Roaming/.minecraft')
        }
      }
      for (const candidate of candidates.slice(0, 32)) {
        if (out.length >= 5) break
        if (!(await consider(candidate))) continue
        if (out.length >= 5 || !INSTANCE_DIR.test(candidate)) continue
        // 实例容器：真正的游戏目录是子目录，认容器自己没用 —— 展开一层。
        for (const child of (await listDir(candidate)).slice(0, 40)) {
          if (out.length >= 5) break
          if (child.type !== 'directory') continue
          const childPath = candidate + '/' + child.name
          if (await looksLikeGameRoot(childPath)) await consider(childPath)
        }
      }
      return out
    }

    async function ensure(namespace) {
      if (preloads.has(namespace)) return preloads.get(namespace)
      for (const other of preloads.values()) if (other.namespace === namespace) return other
      return undefined
    }

