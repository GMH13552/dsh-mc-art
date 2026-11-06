// ── 「启动游戏」卡片（客户端半）────────────────────────────────────────────────
//
// 为什么是**自带组件**而不是塞进 99-entry 里：v2 UI 迁移期间 99-entry.js / 20-const.js
// 是别人正在改的文件，所以这个卡片的所有代码（组件 + 样式 + 轮询）都收在这一个片段里，
// 主视图那边只加一行 `React.createElement(LaunchCard, …)`。
//
// 契约（宿主半 `host/62-launch-handlers.js`）：
//   atlas.launchTargets {root?, project?, gameRoot?} → { gameRoots, versions, javas, javaRejected }
//   atlas.launch        {root?, project?, gameRoot, versionId, javaPath, gameDir?, memoryMb?, extraArgs?, dryRun?}
//   atlas.launchStatus  {} → { running, pid, startedAt, exitCode, tail }
//   atlas.launchStop    {} → { stopped, exitCode }
//
// 三条硬规则：
//   1. **不许碰浏览器计时器**（动态插件沙箱里没有 setTimeout，碰了整个页签会崩）——
//      轮询只用壳给的 `timer` 服务，由调用方当 prop 传进来（和 99-entry 里动画同一条路）。
//   2. 失败必须说**人话**（"没找到 JDK 17：用下拉换一个"），技术原话只放在详情里。
//   3. 日志最多 80 行、自动贴底；卡片不写任何文件（日志由宿主/子进程写）。

const LAUNCH_MEMORY_CHOICES = [1, 2, 3, 4, 6, 8]
const LAUNCH_TAIL_MAX = 80
const LAUNCH_POLL_MS = 700

const LAUNCH_CSS = [
  '.mcart-launchlog{max-height:220px;overflow-y:auto;margin:0;padding:8px 10px;'
    + 'border:1px solid var(--line);border-radius:var(--r-sm);background:var(--canvas);'
    + 'color:var(--ink2);font-family:ui-monospace,Consolas,monospace;font-size:12px;'
    + 'line-height:16px;white-space:pre-wrap;word-break:break-all}',
  '.mcart-launchok{color:var(--dsw-alias-state-success-primary,#7fc98a)}',
  '.mcart-launchmeta{font-size:12px;color:var(--ink3)}',
  '.mcart-launchmeta .mcart-id{font-size:12px}',
].join('')

let launchCssInstalled = false

function launchEnsureCss(styles) {
  if (launchCssInstalled === true) return
  if (styles === undefined || styles === null || typeof styles.insert !== 'function') return
  launchCssInstalled = true
  try { styles.insert(LAUNCH_CSS) } catch (error) { /* 样式失败不该把面板弄没 */ }
}

function launchText(value) {
  return value === undefined || value === null ? '' : String(value)
}

function launchArr(value) {
  return Array.isArray(value) ? value : []
}

/** 版本 id 一眼能认出来的写法：带 Forge/NeoForge 的排前面（调试模组就是跑这些）。 */
function launchForgeFirst(versions) {
  const list = launchArr(versions).slice()
  list.sort((left, right) => {
    const leftForge = /forge/i.test(launchText(left.id)) ? 0 : 1
    const rightForge = /forge/i.test(launchText(right.id)) ? 0 : 1
    if (leftForge !== rightForge) return leftForge - rightForge
    return 0
  })
  return list
}

function launchJavaLabel(java) {
  const major = Number(java === null || java === undefined ? 0 : java.major)
  const version = launchText(java === null || java === undefined ? '' : java.version)
  const source = launchText(java === null || java === undefined ? '' : java.source)
  const head = Number.isFinite(major) && major > 0 ? 'Java ' + String(major) : 'Java'
  const body = version === '' ? head : head + ' · ' + version
  return source === '' ? body : body + '（' + source + '）'
}

function launchVersionLabel(version) {
  const id = launchText(version === null || version === undefined ? '' : version.id)
  const missingJar = version !== null && version !== undefined && version.hasJar === false
  return missingJar ? id + '（目录里没有 jar）' : id
}

function launchStatusText(status) {
  if (status === null || status === undefined) return '未运行'
  if (status.running === true) {
    return '运行中 · pid ' + launchText(status.pid === null || status.pid === undefined ? '?' : status.pid)
  }
  const code = status.exitCode
  if (code === null || code === undefined) return '已停止'
  return '已退出 · 退出码 ' + String(code)
}

/**
 * 失败信息翻成人话。**不许只甩技术原话**：同一个 `error` 字段，先给"接下来做什么"，
 * 技术细节留在括号里/日志里。
 */
function launchHumanError(raw) {
  const text = launchText(raw)
  if (text === '') return '启动失败（宿主没有说明原因）。先看下面的日志尾巴。'
  if (/没有选 JDK|这个 JDK 跑不起来|JAVA_HOME/.test(text)) {
    return '没找到能用的 JDK。1.18.2 要 Java 17 —— 用下面的「JDK」下拉换一个（带 Java 17 的那项是游戏自带的），或者把 JAVA_HOME 指到 17 再点「重新探测」。'
  }
  if (/没有 subprocess/.test(text)) {
    return '这个宿主起不了子进程（没有 subprocess 服务），所以启动不了游戏 —— 换桌面版宿主再试。'
  }
  if (/游戏文件不全/.test(text)) {
    return text + ' 先用启动器把 1.18.2 完整跑一次（缺的库会补上），再回来启动。'
  }
  if (/找不到版本 JSON/.test(text)) return text
  if (/natives/.test(text)) {
    return text + ' 解压工具（tar / Expand-Archive）可能不可用；关掉杀毒软件再试，或手动解开 natives。'
  }
  if (/已经有一个游戏在跑/.test(text)) return text
  return '启动失败：' + text
}

/** 表单默认值：只填空，不覆盖用户已经选的。 */
function launchDefaultForm(previous, gameRoots, versions, javas) {
  const previousRoot = previous === null || previous === undefined ? '' : launchText(previous.gameRoot)
  const previousDir = previous === null || previous === undefined ? '' : launchText(previous.gameDir)
  const form = previous === null || previous === undefined
    ? { gameRoot: '', versionId: '', javaPath: '', memoryMb: 4, gameDir: '' }
    : Object.assign({}, previous)
  if (form.gameRoot === '' || launchArr(gameRoots).indexOf(form.gameRoot) < 0) {
    form.gameRoot = launchArr(gameRoots).length > 0 ? gameRoots[0] : form.gameRoot
  }
  const rootVersions = launchForgeFirst(launchArr(versions).filter((item) =>
    item === null || item === undefined || item.root === undefined || item.root === form.gameRoot))
  const usable = rootVersions.filter((item) => item !== null && item !== undefined && item.hasJar !== false)
  const list = usable.length > 0 ? usable : rootVersions
  const hasCurrent = list.some((item) => launchText(item.id) === form.versionId)
  if (form.versionId === '' || hasCurrent !== true) {
    form.versionId = list.length > 0 ? launchText(list[0].id) : ''
  }
  const version = list.filter((item) => launchText(item.id) === form.versionId)[0]
  const wanted = version !== undefined && version !== null && Number(version.javaMajor) > 0
    ? Number(version.javaMajor) : 17
  const hasJava = launchArr(javas).some((item) => launchText(item.path) === form.javaPath)
  if (form.javaPath === '' || hasJava !== true) {
    const exact = launchArr(javas).filter((item) => Number(item.major) === wanted)[0]
    const seventeen = launchArr(javas).filter((item) => Number(item.major) === 17)[0]
    const chosen = exact !== undefined ? exact : (seventeen !== undefined ? seventeen : launchArr(javas)[0])
    form.javaPath = chosen === undefined || chosen === null ? '' : launchText(chosen.path)
  }
  if (previousDir === '' || previousDir === previousRoot) form.gameDir = form.gameRoot
  if (!Array.isArray(form.gameRoot)) form.gameRoot = launchText(form.gameRoot)
  return form
}

function launchProjectRunDir(root, projectId) {
  const base = launchText(root)
  const id = launchText(projectId)
  if (base === '') return ''
  return id === '' ? base + '/run' : base + '/' + id + '/run'
}

/**
 * 「启动游戏」卡片。props:
 *   host, timer, styles —— 壳给的服务（timer 必须传进来：沙箱里没有浏览器计时器）
 *   root, projectId    —— 面板当前打开的项目（日志落在项目目录里）
 */
function LaunchCard(props) {
  const host = props.host
  const timer = props.timer
  const styles = props.styles
  const root = launchText(props.root)
  const projectId = props.projectId === undefined || props.projectId === null ? '' : launchText(props.projectId)

  const targetsPair = React.useState(null)
  const targets = targetsPair[0], setTargets = targetsPair[1]
  const formPair = React.useState(null)
  const form = formPair[0], setForm = formPair[1]
  const statusPair = React.useState(null)
  const status = statusPair[0], setStatus = statusPair[1]
  const busyPair = React.useState(false)
  const busy = busyPair[0], setBusy = busyPair[1]
  const noticePair = React.useState(null)
  const notice = noticePair[0], setNotice = noticePair[1]
  const reloadPair = React.useState(0)
  const reloadTick = reloadPair[0], setReloadTick = reloadPair[1]
  const logRef = React.useRef(null)

  const call = (name, args) => {
    if (host === null || host === undefined || typeof host.call !== 'function') {
      return Promise.reject(new Error('面板没有连上宿主（host.call 不可用）'))
    }
    return host.call(name, args === undefined ? {} : args)
  }

  // 样式只插一次（组件可能因为换项目重挂载，但 CSS 是全局的）。
  React.useEffect(() => { launchEnsureCss(styles) }, [])

  // 打开卡片 / 换项目 / 点重新探测时取一次目标（游戏根、版本、JDK）。
  React.useEffect(() => {
    let alive = true
    setTargets({ loading: true, error: null, gameRoots: [], versions: [], javas: [], javaRejected: [] })
    call('atlas.launchTargets', { root: root, project: projectId }).then((result) => {
      if (alive !== true) return
      if (result === null || result === undefined) {
        setTargets({ loading: false, error: '宿主没有返回启动目标（插件版本比面板旧？）', gameRoots: [], versions: [], javas: [], javaRejected: [] })
        return
      }
      if (result.error !== undefined && result.error !== null) {
        setTargets({ loading: false, error: launchText(result.error), gameRoots: [], versions: [], javas: [], javaRejected: [] })
        return
      }
      const gameRoots = launchArr(result.gameRoots)
      const versions = launchArr(result.versions)
      const javas = launchArr(result.javas)
      setTargets({ loading: false, error: null, gameRoots: gameRoots, versions: versions, javas: javas,
        javaRejected: launchArr(result.javaRejected), settingsDirectory: launchText(result.settingsDirectory) })
      setForm((previous) => launchDefaultForm(previous, gameRoots, versions, javas))
    }).catch((error) => {
      if (alive !== true) return
      const text = launchText(error === undefined || error === null ? '' : error.message)
      setTargets({ loading: false,
        error: /没有这个方法/.test(text) ? '这个宿主还没有启动器（插件和面板版本对不上）。重载插件/重启应用再试。' : '探测启动目标失败：' + text,
        gameRoots: [], versions: [], javas: [], javaRejected: [] })
    })
    return () => { alive = false }
  }, [root, projectId, reloadTick])

  // 运行中每 700ms 读一次状态（日志尾巴 + 退出码）。**只用壳的 timer.interval**。
  const running = status !== null && status !== undefined && status.running === true
  React.useEffect(() => {
    if (running !== true) return undefined
    if (timer === null || timer === undefined || typeof timer.interval !== 'function') return undefined
    let dispose = null
    try {
      dispose = timer.interval(() => {
        call('atlas.launchStatus', {}).then((result) => {
          if (result === null || result === undefined) return
          setStatus(result)
        }).catch(() => { /* 一帧读失败不刷屏：下一帧再试 */ })
      }, LAUNCH_POLL_MS)
    } catch (error) { dispose = null }
    return () => { try { if (typeof dispose === 'function') dispose() } catch (error) { /* 已释放 */ } }
  }, [running])

  const tailLines = status === null || status === undefined ? [] : launchArr(status.tail).slice(-LAUNCH_TAIL_MAX)
  const tailKey = tailLines.length === 0 ? '' : String(tailLines.length) + '|' + launchText(tailLines[tailLines.length - 1])
  React.useEffect(() => {
    const node = logRef.current
    if (node === null || node === undefined) return
    try { node.scrollTop = node.scrollHeight } catch (error) { /* 不是真 DOM */ }
  }, [tailKey])

  const pickVersion = (version) => {
    if (form === null) return
    const wanted = version !== null && version !== undefined && Number(version.javaMajor) > 0
      ? Number(version.javaMajor) : 17
    const javas = targets === null ? [] : launchArr(targets.javas)
    const exact = javas.filter((item) => Number(item.major) === wanted)[0]
    const seventeen = javas.filter((item) => Number(item.major) === 17)[0]
    const chosen = exact !== undefined ? exact : (seventeen !== undefined ? seventeen : javas[0])
    setForm(Object.assign({}, form, {
      versionId: launchText(version === null || version === undefined ? '' : version.id),
      javaPath: chosen === undefined || chosen === null ? form.javaPath : launchText(chosen.path),
    }))
  }

  const update = (patch) => {
    if (form === null) return
    setForm(Object.assign({}, form, patch))
  }

  const startGame = () => {
    if (form === null || busy === true) return
    if (launchText(form.gameRoot) === '') { setNotice('还没有游戏目录（.minecraft）——先在上面的「游戏目录」里填一个。'); return }
    if (launchText(form.versionId) === '') { setNotice('还没有选版本 —— 下拉里没有版本的话，游戏目录可能指错了。'); return }
    if (launchText(form.javaPath) === '') { setNotice('没找到 JDK 17：用「JDK」下拉换一个，或把 JAVA_HOME 指到 17 再点「重新探测」。'); return }
    setBusy(true)
    setNotice(null)
    call('atlas.launch', {
      root: root, project: projectId,
      gameRoot: form.gameRoot, versionId: form.versionId, javaPath: form.javaPath,
      gameDir: form.gameDir,
      // 下拉里是 GB，宿主契约是 MB。
      memoryMb: (Number(form.memoryMb) || 4) * 1024,
    }).then((result) => {
      setBusy(false)
      if (result === null || result === undefined) { setNotice('启动失败：宿主没有返回结果。'); return }
      if (result.error !== undefined && result.error !== null) { setNotice(launchHumanError(result.error)); return }
      setStatus({ running: true, pid: result.pid, startedAt: result.startedAt, exitCode: null, tail: [] })
      if (result.warning !== undefined && result.warning !== null && launchText(result.warning) !== '') {
        setNotice('已经启动，但注意：' + launchText(result.warning))
      } else {
        setNotice('已经启动（pid ' + launchText(result.pid) + '）。日志在下面实时跟。')
      }
    }).catch((error) => {
      setBusy(false)
      setNotice(launchHumanError(error === undefined || error === null ? '' : error.message))
    })
  }

  const stopGame = () => {
    if (busy === true) return
    setBusy(true)
    setNotice(null)
    call('atlas.launchStop', {}).then((result) => {
      setBusy(false)
      if (result !== null && result !== undefined && result.stopped === true) {
        setNotice('已停止' + (result.exitCode === null || result.exitCode === undefined ? '' : '（退出码 ' + String(result.exitCode) + '）') + '。')
      } else if (result !== null && result !== undefined && result.detail !== undefined && launchText(result.detail) !== '') {
        setNotice(launchText(result.detail))
      } else {
        setNotice('没有在跑的游戏。')
      }
      return call('atlas.launchStatus', {})
    }).then((result) => {
      if (result !== null && result !== undefined) setStatus(result)
    }).catch((error) => {
      setBusy(false)
      setNotice('停止失败：' + launchText(error === undefined || error === null ? '' : error.message))
    })
  }

  if (form === null || targets === null) {
    return React.createElement('div', { className: 'mcart-card' },
      React.createElement('div', { className: 'mcart-bar' },
        React.createElement('span', { className: 'mcart-title' }, '启动游戏'),
        React.createElement('span', { className: 'mcart-sub' }, '读取中…')))
  }

  const gameRoots = launchArr(targets.gameRoots)
  const versions = launchForgeFirst(launchArr(targets.versions).filter((item) =>
    item === null || item === undefined || item.root === undefined || item.root === form.gameRoot))
  const javas = launchArr(targets.javas)
  const selectedVersion = versions.filter((item) => launchText(item.id) === launchText(form.versionId))[0]
  const selectedJava = javas.filter((item) => launchText(item.path) === launchText(form.javaPath))[0]
  const javaMajor = selectedJava === undefined || selectedJava === null ? 0 : Number(selectedJava.major)
  const wantedMajor = selectedVersion === undefined || selectedVersion === null || !(Number(selectedVersion.javaMajor) > 0)
    ? 0 : Number(selectedVersion.javaMajor)
  const mismatch = wantedMajor > 0 && javaMajor > 0 && wantedMajor !== javaMajor

  const prop = (key, label, value) => React.createElement('div', { className: 'mcart-prop', key: key },
    React.createElement('span', { className: 'mcart-prop-label' }, label),
    React.createElement('span', { className: 'mcart-prop-value' }, value))
  const hint = (key, text) => prop(key, '', React.createElement('span', { className: 'mcart-note' }, text))
  const row = (key, children) => React.createElement('div', { className: 'mcart-bar', key: key }, children)

  const rows = []
  rows.push(React.createElement('div', { className: 'mcart-bar', key: 'head' },
    React.createElement('span', { className: 'mcart-title' }, '启动游戏'),
    React.createElement('span', { className: running ? 'mcart-sub mcart-launchok' : 'mcart-sub' }, launchStatusText(status)),
    React.createElement('span', { className: 'mcart-headgrow' }),
    React.createElement('button', {
      className: 'mcart-btn', type: 'button',
      title: '重新探测游戏目录 / 版本 / JDK',
      onClick: () => { setReloadTick(reloadTick + 1); setNotice(null) },
    }, '重新探测')))

  if (targets.loading === true) {
    rows.push(React.createElement('div', { className: 'mcart-note', key: 'loading' }, '正在找游戏目录、版本和 JDK…（JDK 会真的跑一次 -version）'))
  } else if (targets.error !== null && targets.error !== undefined) {
    rows.push(React.createElement('div', { className: 'mcart-err', key: 'err' }, launchText(targets.error)))
  }

  // ── 游戏目录 ────────────────────────────────────────────────────────────────
  if (gameRoots.length === 0) {
    rows.push(prop('gameroot-input', '游戏目录', [
      React.createElement('input', {
        key: 'in', className: 'mcart-input', type: 'text',
        placeholder: '%APPDATA%\\.minecraft 或某个整合包的 .minecraft',
        value: launchText(form.gameRoot),
        onChange: (event) => {
          const next = launchText(event.target.value)
          update({ gameRoot: next })
        },
      }),
      React.createElement('button', {
        key: 'probe', className: 'mcart-btn', type: 'button',
        onClick: () => { setReloadTick(reloadTick + 1); setNotice(null) },
      }, '用这个目录'),
    ]))
    rows.push(React.createElement('div', { className: 'mcart-note', key: 'nogame' },
      '没自动找到游戏目录。把 .minecraft 的完整路径贴进上面那栏再点「用这个目录」；'
      + '也可以先在上面填好，点「重新探测」会读它的 versions/。'))
  } else {
    rows.push(prop('gameroot', '游戏目录', React.createElement('select', {
      className: 'mcart-select', value: launchText(form.gameRoot),
      onChange: (event) => {
        const next = launchText(event.target.value)
        const old = launchText(form.gameRoot)
        const nextDir = launchText(form.gameDir) === '' || launchText(form.gameDir) === old ? next : form.gameDir
        setForm(Object.assign({}, form, { gameRoot: next, gameDir: nextDir }))
      },
    }, gameRoots.map((item) => React.createElement('option', { key: item, value: item }, item)))))
  }

  // ── 版本 ────────────────────────────────────────────────────────────────────
  if (versions.length === 0) {
    rows.push(prop('version', '版本', React.createElement('span', { className: 'mcart-note' },
      launchText(form.gameRoot) === '' ? '先给游戏目录' : '这个游戏目录里没有可启动的版本（versions/ 是空的）')))
  } else {
    rows.push(prop('version', '版本', React.createElement('select', {
      className: 'mcart-select', value: launchText(form.versionId),
      onChange: (event) => {
        const id = launchText(event.target.value)
        pickVersion(versions.filter((item) => launchText(item.id) === id)[0])
      },
    }, versions.map((item) => React.createElement('option', {
      key: launchText(item.id) + '|' + launchText(item.root), value: launchText(item.id),
    }, launchVersionLabel(item))))))
    if (selectedVersion !== undefined && selectedVersion !== null) {
      const chain = launchArr(selectedVersion.chain)
      const bits = []
      if (selectedVersion.mainClass !== undefined && launchText(selectedVersion.mainClass) !== '') bits.push(launchText(selectedVersion.mainClass))
      if (wantedMajor > 0) bits.push('要 Java ' + String(wantedMajor))
      if (selectedVersion.hasJar === false) bits.push('目录里没有客户端 jar（启动会失败）')
      rows.push(hint('versionhint', bits.join(' · ')))
    }
  }

  // ── JDK ────────────────────────────────────────────────────────────────────
  if (javas.length === 0) {
    rows.push(prop('java', 'JDK', React.createElement('span', { className: 'mcart-err' },
      '没找到 JDK。1.18.2 要 Java 17 —— 装一个，或把 JAVA_HOME 指到 17，再点右上「重新探测」。')))
    const rejected = launchArr(targets.javaRejected)
    if (rejected.length > 0) {
      rows.push(hint('javahint', '试过但用不了：' + rejected.slice(0, 3).map((item) =>
        launchText(item.path) + '（' + launchText(item.why) + '）').join('；')))
    }
  } else {
    rows.push(prop('java', 'JDK', [
      React.createElement('select', {
        key: 'sel', className: 'mcart-select', value: launchText(form.javaPath),
        onChange: (event) => update({ javaPath: launchText(event.target.value) }),
      }, javas.map((item) => React.createElement('option', {
        key: launchText(item.path), value: launchText(item.path), title: launchText(item.path),
      }, launchJavaLabel(item)))),
      javaMajor === 17
        ? React.createElement('span', { key: 'ok', className: 'mcart-launchok', title: '1.18.2 这一代要 Java 17' }, '17')
        : null,
    ]))
    if (selectedJava !== undefined && selectedJava !== null) {
      rows.push(hint('javahint', launchText(selectedJava.path)))
    }
    if (mismatch) {
      rows.push(React.createElement('div', { className: 'mcart-bad', key: 'mismatch' },
        '版本要 Java ' + String(wantedMajor) + '，现在选的是 Java ' + String(javaMajor)
        + (javas.some((item) => Number(item.major) === wantedMajor) ? ' —— 用下拉换成 Java ' + String(wantedMajor) + ' 那项' : '（本机没探测到这个版本要的 JDK）')))
    }
  }

  // ── 内存 ────────────────────────────────────────────────────────────────────
  rows.push(prop('memory', '内存', React.createElement('select', {
    className: 'mcart-select', value: String(Number(form.memoryMb) || 4),
    onChange: (event) => update({ memoryMb: Number(event.target.value) || 4 }),
  }, LAUNCH_MEMORY_CHOICES.map((gb) => React.createElement('option', { key: String(gb), value: String(gb) },
    String(gb) + ' GB')))))

  // ── 游戏目录（gameDir：存档/配置落在哪）──────────────────────────────────────
  rows.push(prop('gamedir', '游戏目录', [
    React.createElement('input', {
      key: 'in', className: 'mcart-input', type: 'text',
      placeholder: '存档/配置的目录（默认 = 游戏根）',
      value: launchText(form.gameDir),
      onChange: (event) => update({ gameDir: launchText(event.target.value) }),
    }),
    React.createElement('button', {
      key: 'run', className: 'mcart-btn', type: 'button',
      title: '填成项目里的 run/（模组开发常用）',
      onClick: () => update({ gameDir: launchProjectRunDir(root, projectId) }),
    }, '用项目 run/'),
  ]))

  // ── 操作 ────────────────────────────────────────────────────────────────────
  rows.push(row('actions', [
    React.createElement('button', {
      key: 'start', className: 'mcart-btn mcart-primary', type: 'button',
      disabled: busy === true || running === true || form === null,
      onClick: startGame,
    }, busy === true ? '…' : '启动'),
    React.createElement('button', {
      key: 'stop', className: 'mcart-btn', type: 'button',
      disabled: busy === true || running !== true,
      onClick: stopGame,
    }, '停止'),
    status !== null && status !== undefined && status.exitCode !== null && status.exitCode !== undefined
      ? React.createElement('span', {
        key: 'code',
        className: status.exitCode === 0 ? 'mcart-num mcart-launchok' : 'mcart-num mcart-bad',
      }, '退出码 ' + String(status.exitCode))
      : null,
  ]))

  if (notice !== null && notice !== undefined) {
    const isError = /失败|没找到|用不了|起不来|注意/.test(launchText(notice))
    rows.push(React.createElement('div', { key: 'notice', className: isError ? 'mcart-bad' : 'mcart-note' }, launchText(notice)))
  }
  // 宿主在退出码非 0 时会补一句人话（"游戏写不了自己的目录…"）；有就照原样显示。
  const statusNote = status === null || status === undefined ? '' : launchText(status.note)
  if (statusNote !== '') {
    rows.push(React.createElement('div', { key: 'statusnote', className: 'mcart-bad' }, statusNote))
  }

  // ── 日志尾巴 ────────────────────────────────────────────────────────────────
  const logRows = []
  logRows.push(React.createElement('pre', {
    key: 'tail', className: 'mcart-launchlog', ref: logRef,
    'aria-label': '启动日志尾巴',
  }, tailLines.length === 0
    ? (running === true ? '（还没有输出 —— JVM 启动中，通常几秒内会出第一行）' : '（还没有日志 —— 点「启动」之后这里会实时跟）')
    : tailLines.join('\n')))
  const logFile = status === null || status === undefined ? '' : launchText(status.logFile)
  logRows.push(React.createElement('div', { key: 'where', className: 'mcart-launchmeta' },
    '最多 ' + String(LAUNCH_TAIL_MAX) + ' 行 · 自动贴底'
    + (logFile === '' ? '' : ' · 完整日志：') ,
    logFile === '' ? null : React.createElement('span', { className: 'mcart-id', title: logFile }, logFile)))
  rows.push(prop('log', '日志', React.createElement('div', { className: 'mcart-stack' }, logRows)))

  return React.createElement('div', { className: 'mcart-card mcart-launch' }, rows)
}
